const fs = require("fs")
const vm = require("vm")
const assert = require("assert")

const path = require("path")
const source = fs.readFileSync(path.join(__dirname, "../DisplayModel.js"), "utf8")
  .replace(/^\.pragma library\s*/m, "")
const context = { JSON, Math, Number, String, Array, Object, isFinite }
vm.createContext(context)
vm.runInContext(source, context)

assert.deepStrictEqual(Array.from(context.resolutions(["1920x1080@60", "1920x1080@144", "2560x1440@60"])), ["1920x1080", "2560x1440"])
assert.strictEqual(context.resolutionOptions(["3840x2400@59.99Hz", "3840x2400@47.99Hz"])[0].label, "3840x2400 (native)")
assert.strictEqual(context.nearestMode(["1920x1080@60", "1920x1080@144"], "1920x1080", 120), "1920x1080@144")
assert.strictEqual(context.nearestMode(["3440x1440@59.97Hz"], "3440x1440", 60), "3440x1440@59.97")
assert.deepStrictEqual(JSON.parse(JSON.stringify(context.refreshOptions(["1920x1080@60.00Hz", "1920x1080@60.00Hz", "1920x1080@59.94Hz"], "1920x1080"))), [
  { value: "60", label: "60 Hz" },
  { value: "59.94", label: "59.94 Hz" }
])
assert.deepStrictEqual(Array.from(context.resolutions(["7680x4320@30.00Hz", "5120x1440@120.00Hz", "3440x1440@59.97Hz"])), ["7680x4320", "5120x1440", "3440x1440"])
assert.strictEqual(context.logicalSize({ mode: "3840x2160@60", scale: 2, transform: 0 }).width, 1920)
assert.strictEqual(context.logicalSize({ mode: "1920x1080@60", scale: 1, transform: 1 }).width, 1080)
assert.strictEqual(context.hasOverlap([
  { mode: "1920x1080@60", scale: 1, transform: 0, x: 0, y: 0 },
  { mode: "1920x1080@60", scale: 1, transform: 0, x: 1800, y: 0 }
]), true)
assert.strictEqual(context.hasOverlap([
  { mode: "1920x1080@60", scale: 1, transform: 0, x: 0, y: 0 },
  { mode: "1920x1080@60", scale: 1, transform: 0, x: 1920, y: 0 }
]), false)
assert.deepStrictEqual(Array.from(context.validScales("1920x1080@60")), [1, 1.2, 1.25, 4 / 3, 1.5, 1.6, 2, 2.5, 3, 4])
assert.ok(context.validScales("3840x2160@60").indexOf(4 / 3) >= 0)

const laptop = { name: "laptop", mode: "2560x1600@165", scale: 1.6, transform: 0, x: 199, y: 0 }
const external = { name: "external", mode: "1920x1080@60", scale: 1, transform: 0, x: 0, y: 1019 }
const stacked = [laptop, external]
assert.strictEqual(context.isConnected(stacked), false)

// Near-misses and deep overlaps should land on the intended side, preserving
// the offset along the edge even when the screens have different scales.
for (const [x, y, expectedX, expectedY] of [
  [0, 1019, 0, 1000], [0, 990, 0, 1000], [0, -1099, 0, -1080],
  [1818, 33, 1799, 33], [-1740, -33, -1721, -33],
  [1299, 31, 1799, 31], [-1171, 20, -1721, 20],
  [71, 665, 71, 1000], [7, -700, 7, -1080],
  [0, 4000, 0, 1000], [0, -5000, 0, -1080],
  [7000, 35, 1799, 35], [-6000, 35, -1721, 35]
]) {
  const placed = context.placeDisplay(stacked, 1, x, y)
  assert.strictEqual(placed[1].x, expectedX)
  assert.strictEqual(placed[1].y, expectedY)
  assert.strictEqual(context.isConnected(placed), true)
  assert.strictEqual(context.hasOverlap(placed), false)
}
assert.strictEqual(external.y, 1019)
// A diagonal drop should leave an edge that is wide enough to cross.
const diagonal = context.placeDisplay(stacked, 1, 4500, 3600)
assert.strictEqual(context.isConnected(diagonal), true)
const diagonalTile = diagonal[1]
const sharedWidth = Math.min(laptop.x + 1600, diagonalTile.x + 1920) - Math.max(laptop.x, diagonalTile.x)
const sharedHeight = Math.min(laptop.y + 1000, diagonalTile.y + 1080) - Math.max(laptop.y, diagonalTile.y)
assert.ok(sharedWidth >= 400 || sharedHeight >= 250)

// Screenshot geometry: the top laptop was released about 470 logical pixels
// inside the Dell. Snap it to the top, keeping its horizontal offset.
const screenshot = [{ ...laptop, x: 139, y: -1000 }, { ...external, x: 0, y: 0 }]
const snappedLaptop = context.placeDisplay(screenshot, 0, 139, -527)
assert.deepStrictEqual([snappedLaptop[0].x, snappedLaptop[0].y], [139, -1000])

// Reachability is transitive and independent of monitor order. Mirrors and
// inactive outputs neither bridge a gap nor need their own shared edge.
const grid = [
  [0, 0], [200, 100], [100, 100], [100, 0], [0, 100], [200, 0]
].map(([x, y]) => ({ mode: "200x200@60", scale: 2, transform: 0, x, y }))
assert.strictEqual(context.isConnected(grid), true)
// Moving the bridge of a three-display chain still leaves both outer
// screens reachable. Fixed displays keep their coordinates.
const chain = [0, 100, 200].map(x => ({ ...grid[0], x, y: 0 }))
const bridgeDrop = context.placeDisplay(chain, 1, 6000, 2400)
assert.strictEqual(context.isConnected(bridgeDrop), true)
assert.strictEqual(context.hasOverlap(bridgeDrop), false)
assert.deepStrictEqual([bridgeDrop[0].x, bridgeDrop[2].x], [0, 200])

const islands = grid.map(d => ({ ...d, x: d.x === 200 ? 201 : d.x }))
assert.strictEqual(context.isConnected(islands), false)
const rotated = { mode: "200x400@60", scale: 2, transform: 1, x: -200, y: 0 }
const excluded = [{ ...external, disabled: true }, { ...external, mirror: "laptop" }]
assert.strictEqual(context.isConnected([...grid, rotated, ...excluded]), true)
assert.strictEqual(context.isConnected([rotated, { ...rotated, x: 1 },
  { ...rotated, x: 0, disabled: true }]), false)

// A rotated tile is 200 × 100 logical pixels. Place it flush against the
// left edge using its rotated width even when it is mostly inside the laptop.
const portraitDrop = context.placeDisplay([laptop, rotated], 1, 125, 320)
assert.deepStrictEqual([portraitDrop[1].x, portraitDrop[1].y], [-1, 320])
assert.strictEqual(context.hasOverlap(portraitDrop), false)

// The desired right edge is partially occupied. Slide along it to the nearest
// open segment so neither fixed output moves when releasing the third tile.
const big = { mode: "300x300@60", scale: 1, transform: 0, x: 0, y: 0 }
const neighbor = { ...grid[0], x: 300, y: 0 }
const third = { ...grid[0], x: 0, y: 300 }
const corner = [big, neighbor, third]
const slotted = context.placeDisplay(corner, 2, 240, 70)
assert.deepStrictEqual([slotted[2].x, slotted[2].y], [300, 100])
assert.deepStrictEqual(JSON.parse(JSON.stringify(slotted.slice(0, 2))), [big, neighbor])
assert.strictEqual(context.hasOverlap(slotted), false)
assert.strictEqual(context.isConnected(slotted), true)

// A tile aimed at the right side of an ultrawide should go to its right,
// even when a vertical edge correction would be shorter in raw pixels.
const wide = { ...big, mode: "2400x600@60" }
const inside = context.placeDisplay([wide, third], 1, 1900, 210)
assert.deepStrictEqual([inside[1].x, inside[1].y], [2400, 210])

// Covering an identical tile completely is ambiguous, but the result must be
// usable. Dropping it again at the returned coordinates should be a no-op.
const centered = context.placeDisplay([grid[0], third], 1, 0, 0)
assert.strictEqual(context.hasOverlap(centered), false)
assert.strictEqual(context.isConnected(centered), true)
const settled = context.placeDisplay(centered, 1, centered[1].x, centered[1].y)
assert.deepStrictEqual(settled, centered)

console.log("DisplayModel tests passed")
