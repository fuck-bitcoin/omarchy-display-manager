#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin" "$fixture_dir/state"

cat >"$fixture_dir/monitors.json" <<'JSON'
[
  {"name":"eDP-1","description":"Internal","make":"BOE","model":"Panel","serial":"ABC","disabled":false,"focused":true,"width":1920,"height":1200,"refreshRate":60.001,"x":0,"y":0,"scale":1,"transform":0,"mirrorOf":"none","availableModes":["1920x1200@60.001","1280x800@60"]},
  {"name":"DP-1","description":"Desk","make":"Dell","model":"U2723QE","serial":"XYZ","disabled":false,"focused":false,"width":3840,"height":2160,"refreshRate":60,"x":1920,"y":0,"scale":2,"transform":0,"mirrorOf":"none","availableModes":["3840x2160@60","2560x1440@60"]}
]
JSON

cat >"$fixture_dir/bin/hyprctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == -j && ${2:-} == monitors ]]; then
  cat "$TEST_MONITORS"
  exit 0
fi

if [[ ${1:-} == eval ]]; then
  expression=${2:-}
  printf '%s\n' "$expression" >>"$TEST_CALLS"

  if [[ -f $TEST_FAIL_NEXT_EVAL ]]; then
    rm -f "$TEST_FAIL_NEXT_EVAL"
    exit 1
  fi

  if [[ -f $TEST_FAIL_EVAL_AT ]]; then
    fail_at=$(<"$TEST_FAIL_EVAL_AT")
    if (( fail_at <= 1 )); then
      rm -f "$TEST_FAIL_EVAL_AT"
      exit 1
    fi
    printf '%s\n' "$((fail_at - 1))" >"$TEST_FAIL_EVAL_AT"
  fi

  if [[ -f $TEST_IGNORE_EVALS ]]; then
    remaining=$(<"$TEST_IGNORE_EVALS")
    if (( remaining > 0 )); then
      printf '%s\n' "$((remaining - 1))" >"$TEST_IGNORE_EVALS"
      exit 0
    fi
  fi

  [[ $expression =~ output[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]] || exit 1
  name=${BASH_REMATCH[1]}
  tmp="$TEST_MONITORS.tmp"

  if [[ $expression == *"disabled = true"* ]]; then
    jq --arg name "$name" 'map(if .name == $name then .disabled = true else . end)' \
      "$TEST_MONITORS" >"$tmp"
  else
    [[ $expression =~ mode[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]] || exit 1
    mode=${BASH_REMATCH[1]}
    [[ $mode =~ ^([0-9]+)x([0-9]+)@([0-9.]+)$ ]] || exit 1
    width=${BASH_REMATCH[1]}
    height=${BASH_REMATCH[2]}
    refresh=${BASH_REMATCH[3]}
    [[ $expression =~ position[[:space:]]*=[[:space:]]*\"(-?[0-9]+)x(-?[0-9]+)\" ]] || exit 1
    x=${BASH_REMATCH[1]}
    y=${BASH_REMATCH[2]}
    [[ $expression =~ scale[[:space:]]*=[[:space:]]*([0-9.]+) ]] || exit 1
    scale=${BASH_REMATCH[1]}
    [[ $expression =~ transform[[:space:]]*=[[:space:]]*([0-7]) ]] || exit 1
    transform=${BASH_REMATCH[1]}
    mirror=none
    if [[ $expression =~ mirror[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
      mirror=${BASH_REMATCH[1]}
    fi
    jq --arg name "$name" --arg mirror "$mirror" \
      --argjson width "$width" --argjson height "$height" --argjson refresh "$refresh" \
      --argjson x "$x" --argjson y "$y" --argjson scale "$scale" --argjson transform "$transform" '
      map(if .name == $name then
        .disabled = false
        | .width = $width | .height = $height | .refreshRate = $refresh
        | .x = $x | .y = $y | .scale = $scale | .transform = $transform
        | .mirrorOf = $mirror
      else . end)' "$TEST_MONITORS" >"$tmp"
  fi
  mv "$tmp" "$TEST_MONITORS"
  exit 0
fi

exit 1
SH

cat >"$fixture_dir/bin/systemd-run" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_SYSTEMD_CALLS"
if [[ -f $TEST_FAIL_NEXT_SYSTEMD_RUN ]]; then
  rm -f "$TEST_FAIL_NEXT_SYSTEMD_RUN"
  exit 1
fi
exit 0
SH

cat >"$fixture_dir/bin/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_SYSTEMCTL_CALLS"
exit 0
SH

chmod +x "$fixture_dir/bin/"*

export PATH="$fixture_dir/bin:$PATH"
export XDG_STATE_HOME="$fixture_dir/state"
export TEST_MONITORS="$fixture_dir/monitors.json"
export TEST_CALLS="$fixture_dir/calls"
export TEST_SYSTEMD_CALLS="$fixture_dir/systemd-calls"
export TEST_SYSTEMCTL_CALLS="$fixture_dir/systemctl-calls"
export TEST_FAIL_NEXT_EVAL="$fixture_dir/fail-next-eval"
export TEST_FAIL_EVAL_AT="$fixture_dir/fail-eval-at"
export TEST_IGNORE_EVALS="$fixture_dir/ignore-evals"
export TEST_FAIL_NEXT_SYSTEMD_RUN="$fixture_dir/fail-next-systemd-run"
export DISPLAY_MANAGER_SETTLE_SECONDS=0
helper="$project_dir/bin/display-manager"

state=$($helper state)
jq -e 'length == 2 and .[0].fingerprint == "BOE|Panel|ABC" and .[1].scale == 2' <<<"$state" >/dev/null
[[ $($helper topology) == '"BOE|Panel|ABC::Dell|U2723QE|XYZ"' ]]

# Even a one-pixel gap or a corner-only contact breaks pointer traversal.
# Rejected previews must fail before mutating the live layout.
for candidate in \
  "$(jq -c '.[1].x += 1' <<<"$state")" \
  "$(jq -c '.[1] += {x:199,y:1219}' <<<"$state")" \
  "$(jq -c '.[1].y = 1200' <<<"$state")"; do
  if error=$($helper preview "$candidate" 2>&1); then exit 1; fi
  jq -e '.error | contains("shared edge")' <<<"$error" >/dev/null
done
[[ ! -s $TEST_CALLS ]]

# Each display must reach the entire group, even when every display touches
# at least one neighbor. Disabled and mirrored outputs cannot bridge a gap.
six=$(jq -c '.[0] as $panel | [range(6) as $i |
  $panel + {name:("D" + ($i|tostring)), x:(($i%3)*1920), y:(if $i<3 then -1200 else 0 end)}]' <<<"$state")
$helper profiles-save Grid "$six" false >/dev/null
for filter in \
  'map(if .y == 0 then .y = 1 else . end)' \
  '.[1].disabled=true | .[4].disabled=true' \
  '.[1].mirror="D0" | .[4].mirror="D0"'; do
  island=$(jq -c "$filter" <<<"$six")
  if $helper profiles-save Islands "$island" false >/dev/null 2>&1; then exit 1; fi
done
$helper profiles-delete Grid >/dev/null

# Legacy profiles with gaps cannot be activated or overwrite the user's
# current layout. A preview started FROM such a live layout can still revert.
store=$XDG_STATE_HOME/omarchy-display-manager/profiles.json
disconnected=$(jq -c '.[1].x += 19' <<<"$state")
jq --argjson config "$disconnected" --arg key "$($helper topology)" \
  '.profiles = [{name:"Legacy", automatic:true, topology:$key, displays:$config}]' \
  "$store" >"$fixture_dir/legacy.json"
mv "$fixture_dir/legacy.json" "$store"
$helper profiles-match | jq -e '
  .ok == true and .matched == false and .name == "Legacy" and (.reason | contains("shared edge"))' >/dev/null
$helper profiles-list | jq -e --argjson config "$disconnected" '
  .profiles[0].automatic == true and .profiles[0].displays == $config' >/dev/null
[[ ! -s $TEST_CALLS ]]
$helper profiles-delete Legacy >/dev/null

jq '.[1].x += 19' "$TEST_MONITORS" >"$fixture_dir/gapped.json"
mv "$fixture_dir/gapped.json" "$TEST_MONITORS"
$helper preview "$state" >/dev/null
$helper rollback >/dev/null
[[ $($helper state) == "$disconnected" ]]
[[ ! -e $XDG_STATE_HOME/omarchy-display-manager/pending.json ]]

config=$(jq -c '[.[0] + {x:1920,transform:1,mode:"1920x1200@60.001Hz"}, .[1] + {x:0}]' <<<"$state")
$helper preview "$config" >/dev/null
grep -q '^hl.monitor({ output = "eDP-1", mode = "1920x1200@60.001", position = "1920x0", scale = 1, transform = 1 })$' "$TEST_CALLS"
grep -q 'display-manager rollback$' "$TEST_SYSTEMD_CALLS"
$helper state | jq -e '.[0].x == 1920 and .[0].transform == 1 and .[1].x == 0' >/dev/null
$helper confirm >/dev/null

$helper profiles-save Default "$config" true >/dev/null
$helper profiles-list | jq -e '.profiles | length == 1 and .[0].name == "Default" and .[0].automatic == true' >/dev/null

jq '.[1].serial = "XYZ-DOCK-2"' "$TEST_MONITORS" >"$fixture_dir/next-topology.json"
mv "$fixture_dir/next-topology.json" "$TEST_MONITORS"
second_state=$($helper state)
$helper profiles-save Default "$second_state" true >/dev/null
$helper profiles-list | jq -e '
  .profiles | length == 2
  and all(.[]; .name == "Default" and .automatic == true)
  and ([.[].topology] | unique | length) == 2' >/dev/null
$helper profiles-match | jq -e '.matched == true and .name == "Default"' >/dev/null

bad_profile=$(jq -c '.[0].transform = 2' <<<"$second_state")
$helper profiles-save Default "$bad_profile" true >/dev/null
before_match=$(sha256sum "$TEST_MONITORS" | cut -d' ' -f1)
printf '2\n' >"$TEST_IGNORE_EVALS"
if $helper profiles-match >/dev/null 2>&1; then
  echo "Expected a rejected automatic profile to fail" >&2
  exit 1
fi
after_match=$(sha256sum "$TEST_MONITORS" | cut -d' ' -f1)
[[ $before_match == "$after_match" ]]

$helper profiles-delete Default | jq -e '.profiles | length == 0' >/dev/null

for invalid in \
  '[]' \
  "$(jq -c '.[1].name = .[0].name' <<<"$second_state")" \
  "$(jq -c '.[1].x = 1000' <<<"$second_state")" \
  "$(jq -c '.[0].mirror = .[0].name' <<<"$second_state")" \
  "$(jq -c '.[0].mirror = "missing"' <<<"$second_state")"; do
  if $helper preview "$invalid" >/dev/null 2>&1; then
    echo "Expected invalid configuration to fail" >&2
    exit 1
  fi
done

rejected=$(jq -c '.[0].y += 100 | .[0].transform = 3' <<<"$second_state")
printf '2\n' >"$TEST_IGNORE_EVALS"
if $helper preview "$rejected" >/dev/null 2>&1; then
  echo "Expected unapplied position and transform to fail verification" >&2
  exit 1
fi
[[ ! -e $XDG_STATE_HOME/omarchy-display-manager/pending.json ]]

printf '2\n' >"$TEST_IGNORE_EVALS"
printf '3\n' >"$TEST_FAIL_EVAL_AT"
if recovery_error=$($helper preview "$rejected" 2>&1); then
  echo "Expected a failed recovery attempt to be reported" >&2
  exit 1
fi
jq -e '.error | contains("recovery snapshot remains")' <<<"$recovery_error" >/dev/null
[[ -e $XDG_STATE_HOME/omarchy-display-manager/pending.json ]]
rm -f "$XDG_STATE_HOME/omarchy-display-manager/pending.json"

touch "$TEST_FAIL_NEXT_EVAL"
if $helper preview "$second_state" >/dev/null 2>&1; then
  echo "Expected a compositor command failure to roll back" >&2
  exit 1
fi
[[ ! -e $XDG_STATE_HOME/omarchy-display-manager/pending.json ]]

scheduled_failure=$(jq -c '.[0].transform = 2' <<<"$second_state")
touch "$TEST_FAIL_NEXT_SYSTEMD_RUN"
if $helper preview "$scheduled_failure" >/dev/null 2>&1; then
  echo "Expected a rollback scheduling failure to restore the snapshot" >&2
  exit 1
fi
$helper state | jq -e '.[0].transform == 1' >/dev/null
[[ ! -e $XDG_STATE_HOME/omarchy-display-manager/pending.json ]]

mirror_config=$(jq -c '.[0].mirror = .[1].name' <<<"$second_state")
$helper preview "$mirror_config" >/dev/null
$helper state | jq -e '.[0].mirror == "DP-1"' >/dev/null
$helper revert >/dev/null
$helper state | jq -e '.[0].mirror == ""' >/dev/null

echo "display-manager helper tests passed"
