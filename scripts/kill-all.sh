#!/bin/bash
set -u

PORTS=(3000 3001 3002 5173 4173)

echo "=== JustPark Process Cleanup ==="

have_lsof() {
  command -v lsof >/dev/null 2>&1
}

have_ss() {
  command -v ss >/dev/null 2>&1
}

find_port_processes() {
  local port="$1"

  if have_lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2 "|" $1}'
    return
  fi

  if have_ss; then
    ss -ltnp "( sport = :$port )" 2>/dev/null \
      | awk -v target=":$port" '
          $1 == "LISTEN" && $4 ~ target {
            proc = "-";
            pid = "-";
            if (match($0, /users:\(\("([^"]+)",pid=([0-9]+)/, m)) {
              proc = m[1];
              pid = m[2];
            }
            print pid "|" proc;
          }
        '
    return
  fi
}

port_has_listener() {
  local port="$1"
  if have_lsof; then
    lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  if have_ss; then
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"
    return $?
  fi

  return 1
}

kill_port_processes() {
  local port="$1"
  local pids

  if have_lsof; then
    pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u)
  elif have_ss; then
    pids=$(ss -ltnp "( sport = :$port )" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)
  else
    pids=""
  fi

  if [ -z "${pids:-}" ]; then
    return 0
  fi

  echo "Stopping process(es) on port $port: $(echo "$pids" | tr '\n' ' ' | xargs)"
  echo "$pids" | xargs kill -15 2>/dev/null || true
  sleep 2

  local survivors=""
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      survivors="$survivors $pid"
    fi
  done

  if [ -n "$survivors" ]; then
    echo "Force killing stubborn process(es) on port $port:$survivors"
    kill -9 $survivors 2>/dev/null || true
  fi
}

echo "--- Detection ---"
found_any=0
for port in "${PORTS[@]}"; do
  entries=$(find_port_processes "$port")
  if [ -n "${entries:-}" ]; then
    found_any=1
    while IFS='|' read -r pid process_name; do
      [ -n "${pid:-}" ] || continue
      echo "$port | $pid | $process_name"
    done <<< "$entries"
  fi
done

docker_running=0
if command -v docker >/dev/null 2>&1; then
  docker_output=$(docker compose ps --services --status running 2>/dev/null || true)
  if [ -n "${docker_output:-}" ]; then
    docker_running=1
    found_any=1
    echo "Docker containers running:"
    echo "$docker_output"
  fi
fi

if [ "$found_any" -eq 0 ]; then
  echo "Nothing running. All clear."
  exit 0
fi

echo "--- Kill ---"
if command -v docker >/dev/null 2>&1; then
  docker compose down 2>/dev/null || true
fi

for port in "${PORTS[@]}"; do
  kill_port_processes "$port"
done

echo "--- Verification ---"
stubborn=0
for port in "${PORTS[@]}"; do
  entries=$(find_port_processes "$port")
  if [ -n "${entries:-}" ]; then
    stubborn=1
    while IFS='|' read -r pid process_name; do
      [ -n "${pid:-}" ] || continue
      echo "WARN: still running -> $port | $pid | $process_name"
    done <<< "$entries"
  fi
done

if command -v docker >/dev/null 2>&1; then
  docker_output=$(docker compose ps --services --status running 2>/dev/null || true)
  if [ -n "${docker_output:-}" ]; then
    stubborn=1
    echo "WARN: Docker containers still running:"
    echo "$docker_output"
  fi
fi

if [ "$stubborn" -eq 0 ]; then
  echo "All clear"
else
  echo "Cleanup finished with warnings about stubborn processes."
fi
