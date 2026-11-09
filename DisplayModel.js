.pragma library

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function modeParts(mode) {
  var match = String(mode || "").match(/^(\d+)x(\d+)@(\d+(?:\.\d+)?)/)
  return match ? { width: Number(match[1]), height: Number(match[2]), refresh: Number(match[3]) } : null
}

function resolution(mode) {
  var p = modeParts(mode)
  return p ? p.width + "x" + p.height : ""
}

function refresh(mode) {
  var p = modeParts(mode)
  return p ? String(Math.round(p.refresh * 100) / 100) : ""
}

function canonicalMode(mode) {
  var p = modeParts(mode)
  return p ? p.width + "x" + p.height + "@" + (Math.round(p.refresh * 100) / 100) : String(mode || "preferred")
}

function modesForResolution(modes, wanted) {
  return (modes || []).filter(function(mode) { return resolution(mode) === wanted })
}

function refreshOptions(modes, wanted) {
  var seen = {}, result = []
  modesForResolution(modes, wanted).forEach(function(mode) {
    var value = refresh(mode)
    if (value && !seen[value]) {
      seen[value] = true
      result.push({ value: value, label: value + " Hz" })
    }
  })
  return result
}

function resolutions(modes) {
  var seen = {}, result = []
  ;(modes || []).forEach(function(mode) {
    var value = resolution(mode)
    if (value && !seen[value]) { seen[value] = true; result.push(value) }
  })
  return result
}

function resolutionOptions(modes) {
  var values = resolutions(modes)
  return values.map(function(value) {
    return {
      value: value,
      label: values.length === 1 ? value + " (native)" : value
    }
  })
}

function validScales(mode) {
  var p = modeParts(mode)
  if (!p) return [1]
  // Common integer, Windows-style, and fractional Wayland scales. Filter out
  // values that would create fractional logical pixels for the chosen mode.
  var candidates = [1, 1.2, 1.25, 4 / 3, 1.5, 1.6, 1.75, 2, 2.25, 2.5, 3, 4]
  return candidates.filter(function(scale) {
    return Math.abs(p.width / scale - Math.round(p.width / scale)) < 0.0001
      && Math.abs(p.height / scale - Math.round(p.height / scale)) < 0.0001
  })
}

function logicalSize(display) {
  var p = modeParts(display.mode) || { width: display.width || 0, height: display.height || 0 }
  var scale = Number(display.scale) || 1
  var rotated = Number(display.transform) % 2 === 1
  return {
    width: Math.round((rotated ? p.height : p.width) / scale),
    height: Math.round((rotated ? p.width : p.height) / scale)
  }
}

function overlap(a, b) {
  if (a.disabled || b.disabled || a.mirror || b.mirror) return false
  var as = logicalSize(a), bs = logicalSize(b)
  return a.x < b.x + bs.width && a.x + as.width > b.x
      && a.y < b.y + bs.height && a.y + as.height > b.y
}

function hasOverlap(displays) {
  for (var i = 0; i < displays.length; i++)
    for (var j = i + 1; j < displays.length; j++)
      if (overlap(displays[i], displays[j])) return true
  return false
}

function isExtended(display) { return !display.disabled && !display.mirror }

function sharesEdge(a, b) {
  var as = logicalSize(a), bs = logicalSize(b)
  return ((a.x + as.width === b.x || b.x + bs.width === a.x)
          && Math.min(a.y + as.height, b.y + bs.height) > Math.max(a.y, b.y))
      || ((a.y + as.height === b.y || b.y + bs.height === a.y)
          && Math.min(a.x + as.width, b.x + bs.width) > Math.max(a.x, b.x))
}

function isConnected(displays) {
  var screens = displays.filter(isExtended)
  if (!screens.length) return false
  var reached = [screens[0]]
  for (var i = 0; i < reached.length; i++)
    screens.forEach(function(screen) {
      if (reached.indexOf(screen) < 0 && sharesEdge(reached[i], screen)) reached.push(screen)
    })
  return reached.length === screens.length
}

// Only move the dragged output. Keep the offset along the shared edge so
// partially staggered and differently sized screens can match the user's desk.
function placeDisplay(displays, index, x, y) {
  var result = clone(displays), moved = result[index]
  if (!isExtended(moved)) return result
  var movedSize = logicalSize(moved)
  var anchors = result.filter(function(d) { return d !== moved && isExtended(d) })
  var best = null
  var coveredArea = 0, scaleX = 1, scaleY = 1
  // Include the starting offsets so a bridge between groups of displays
  // can stay connected if the requested side has no room for it.
  var slideX = [x, moved.x], slideY = [y, moved.y]

  anchors.forEach(function(anchor) {
    var size = logicalSize(anchor)
    var width = Math.min(x + movedSize.width, anchor.x + size.width) - Math.max(x, anchor.x)
    var height = Math.min(y + movedSize.height, anchor.y + size.height) - Math.max(y, anchor.y)
    if (width > 0 && height > 0 && width * height > coveredArea) {
      coveredArea = width * height
      // Measure the direction from the tile it covers most in proportion to
      // both tiles. Right of center on a wide screen should still mean right.
      scaleX = size.width + movedSize.width
      scaleY = size.height + movedSize.height
    }
    // Along a blocked edge the nearest free position starts or ends at
    // another display boundary.
    slideX.push(anchor.x - movedSize.width, anchor.x + size.width)
    slideY.push(anchor.y - movedSize.height, anchor.y + size.height)
  })

  function distance(dx, dy) {
    return (dx / scaleX) * (dx / scaleX) + (dy / scaleY) * (dy / scaleY)
  }

  function consider(anchor, cx, cy) {
    moved.x = cx
    moved.y = cy
    if (!sharesEdge(moved, anchor) || anchors.some(function(d) { return overlap(moved, d) })) return
    var connected = isConnected(result)
    if (best && best.connected && !connected) return
    var score = distance(cx - x, cy - y)
    var fromStart = distance(cx - displays[index].x, cy - displays[index].y)
    if (!best || connected !== best.connected || score < best.score
        || (score === best.score && fromStart < best.fromStart))
      best = { x: cx, y: cy, score: score, fromStart: fromStart, connected: connected }
  }

  anchors.forEach(function(anchor) {
    var size = logicalSize(anchor)
    var left = anchor.x - movedSize.width, right = anchor.x + size.width
    var top = anchor.y - movedSize.height, bottom = anchor.y + size.height
    // A diagonal drop beyond the end of an edge would otherwise leave a
    // one-pixel crossing. Bring a quarter of the smaller edge into reach.
    // Along a side, preserve the stagger under the pointer.
    var verticalSpan = y <= top || y >= bottom ? Math.ceil(Math.min(size.height, movedSize.height) / 4) : 1
    var horizontalSpan = x <= left || x >= right ? Math.ceil(Math.min(size.width, movedSize.width) / 4) : 1
    slideY.forEach(function(offset) {
      var cy = Math.max(top + verticalSpan, Math.min(bottom - verticalSpan, offset))
      consider(anchor, left, cy)
      consider(anchor, right, cy)
    })
    slideX.forEach(function(offset) {
      var cx = Math.max(left + horizontalSpan, Math.min(right - horizontalSpan, offset))
      consider(anchor, cx, top)
      consider(anchor, cx, bottom)
    })
  })
  if ((!best || !best.connected) && anchors.length) {
    var start = displays[index]
    anchors.forEach(function(anchor) { consider(anchor, start.x, start.y) })
  }
  moved.x = best ? best.x : x
  moved.y = best ? best.y : y
  return result
}

function normalizePositions(displays) {
  var copy = clone(displays), minX = Infinity, minY = Infinity
  copy.forEach(function(d) {
    if (!d.disabled && !d.mirror) { minX = Math.min(minX, d.x); minY = Math.min(minY, d.y) }
  })
  if (!isFinite(minX)) return copy
  copy.forEach(function(d) {
    if (!d.disabled && !d.mirror) { d.x -= minX; d.y -= minY }
  })
  return copy
}

function nearestMode(modes, wantedResolution, wantedRefresh) {
  var choices = modesForResolution(modes, wantedResolution)
  if (!choices.length) return modes && modes.length ? modes[0] : "preferred"
  var target = Number(wantedRefresh), best = choices[0], distance = Infinity
  choices.forEach(function(mode) {
    var delta = Math.abs(Number(refresh(mode)) - target)
    if (delta < distance) { best = mode; distance = delta }
  })
  return canonicalMode(best)
}
