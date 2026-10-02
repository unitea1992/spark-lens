#!/usr/bin/env bash
# Spark Lens host probe.
#
# Prints one machine-readable snapshot of this host and exits. The server runs
# it locally, or pipes it to `ssh <host> bash -s` for remote machines, so the
# monitored hosts need nothing installed and keep no daemon running.
#
# Output is a sequence of "@@<section>" lines, each followed by that section's
# raw rows. Rates (CPU %, network bytes/s) are derived server-side from the
# difference between two snapshots.
#
# Optional environment:
#   SL_PROC_RE   extended regex; matching processes are listed under @@procs
#   SL_MOUNTS    space-separated mount points for @@disk (default: /)

export LC_ALL=C
SL_MOUNTS="${SL_MOUNTS:-/}"

echo "@@host"
echo "hostname=$(hostname)"
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "ncpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
echo "now=$(date +%s.%N)"
read -r up _ < /proc/uptime && echo "uptime=$up"
read -r l1 l5 l15 _ < /proc/loadavg && echo "load=$l1 $l5 $l15"
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    echo "os=$(. /etc/os-release && echo "${PRETTY_NAME:-}")"
fi
model="$(awk -F': *' '/^model name/ {print $2; exit}' /proc/cpuinfo)"
if [ -z "$model" ] && command -v lscpu >/dev/null 2>&1; then
    model="$(lscpu | awk -F': *' '/^Model name/ {print $2}' | paste -sd'+' -)"
fi
echo "cpu_model=$model"

echo "@@cpu"
head -n 1 /proc/stat

echo "@@freq"
# <sum of current kHz> <sum of allowed max kHz> <cores counted> <sum of hardware max kHz>
# The allowed max (scaling_max_freq) reflects a clock cap when one is set.
cur=0; lim=0; hw=0; n=0
for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do
    [ -r "$d/scaling_cur_freq" ] || continue
    read -r c < "$d/scaling_cur_freq"
    read -r m < "$d/cpuinfo_max_freq"
    l="$m"
    [ -r "$d/scaling_max_freq" ] && read -r l < "$d/scaling_max_freq"
    cur=$((cur + c)); lim=$((lim + l)); hw=$((hw + m)); n=$((n + 1))
done
echo "$cur $lim $n $hw"

echo "@@mem"
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo

echo "@@disk"
# shellcheck disable=SC2086
df -P -B1 $SL_MOUNTS 2>/dev/null | tail -n +2

echo "@@temp"
# <chip>|<label>|<millidegrees C>
for h in /sys/class/hwmon/hwmon*; do
    [ -r "$h/name" ] || continue
    read -r chip < "$h/name"
    for f in "$h"/temp*_input; do
        [ -r "$f" ] || continue
        v="$(cat "$f" 2>/dev/null)" || continue
        [ -n "$v" ] || continue
        label=""
        [ -r "${f%_input}_label" ] && label="$(cat "${f%_input}_label" 2>/dev/null)"
        echo "$chip|$label|$v"
    done
done

echo "@@gpu"
# nvidia|<name>|<util %>|<temp C>|<power W>|<mem used MiB>|<mem total MiB>|<clock MHz>|<max clock MHz>
# amd|<name>|<util %>|<temp mC>|<power uW>|<vram used B>|<vram total B>
if command -v nvidia-smi >/dev/null 2>&1; then
    timeout 3 nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total,clocks.current.graphics,clocks.max.graphics \
        --format=csv,noheader,nounits 2>/dev/null | sed -e 's/, /|/g' -e 's/^/nvidia|/'
fi
for card in /sys/class/drm/card[0-9]*; do
    [ -r "$card/device/gpu_busy_percent" ] || continue
    dev="$card/device"
    busy="$(cat "$dev/gpu_busy_percent" 2>/dev/null)"
    temp=""; power=""
    for hw in "$dev"/hwmon/hwmon*; do
        [ -r "$hw/temp1_input" ] && temp="$(cat "$hw/temp1_input" 2>/dev/null)"
        [ -r "$hw/power1_input" ] && power="$(cat "$hw/power1_input" 2>/dev/null)"
        [ -z "$power" ] && [ -r "$hw/power1_average" ] && power="$(cat "$hw/power1_average" 2>/dev/null)"
    done
    used="$(cat "$dev/mem_info_vram_used" 2>/dev/null)"
    total="$(cat "$dev/mem_info_vram_total" 2>/dev/null)"
    echo "amd|$(basename "$card")|$busy|$temp|$power|$used|$total"
done

echo "@@gpucap"
# Upper bound of a GPU clock lock (nvidia-smi -lgc MIN,MAX) persisted in a
# systemd unit, if any. nvidia-smi itself has no query for the active lock.
grep -rhoE -- '(-lgc|--lock-gpu-clocks)[ =]+[0-9]+,[0-9]+' /etc/systemd/system 2>/dev/null | head -n 1 | sed -E 's/.*,//'

echo "@@gpuproc"
# <pid>|<process name>|<used MiB>
if command -v nvidia-smi >/dev/null 2>&1; then
    timeout 3 nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | sed 's/, /|/g'
fi

echo "@@net"
# <iface> <rx bytes> <tx bytes> <operstate> <speed Mb/s>; physical interfaces only
for dev in /sys/class/net/*; do
    [ -e "$dev/device" ] || continue
    i="$(basename "$dev")"
    echo "$i $(cat "$dev/statistics/rx_bytes") $(cat "$dev/statistics/tx_bytes") $(cat "$dev/operstate" 2>/dev/null) $(cat "$dev/speed" 2>/dev/null || echo -1)"
done

echo "@@ib"
# <device> <rcv words> <xmit words> <link Gb/s>; active RDMA ports only.
# RDMA (RoCE) traffic such as NCCL between nodes bypasses the kernel's
# interface counters, so it is only visible here. One word is 4 bytes.
for d in /sys/class/infiniband/*; do
    p="$d/ports/1"
    [ -r "$p/state" ] || continue
    case "$(cat "$p/state" 2>/dev/null)" in *ACTIVE*) ;; *) continue ;; esac
    r="$(cat "$p/counters/port_rcv_data" 2>/dev/null)" || continue
    x="$(cat "$p/counters/port_xmit_data" 2>/dev/null)" || continue
    rate="$(cut -d' ' -f1 < "$p/rate" 2>/dev/null)"
    echo "$(basename "$d") $r $x ${rate:-0}"
done

echo "@@docker"
# <name>|<image>|<state>|<status>
# Ends with "@ok" only when the list was read, so an empty list means no containers.
if command -v docker >/dev/null 2>&1; then
    if sl_ps=$(timeout 4 docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}' 2>/dev/null); then
        [ -n "$sl_ps" ] && printf '%s\n' "$sl_ps"
        echo "@ok"
    fi
fi

echo "@@procs"
# <pid>|<elapsed s>|<cpu %>|<rss KiB>|<cwd>|<args>
if [ -n "${SL_PROC_RE:-}" ]; then
    # One awk pass picks the matches; only those pay for a readlink.
    ps -eo pid=,etimes=,pcpu=,rss=,args= 2>/dev/null | awk -v self="$$" '
        BEGIN { re = ENVIRON["SL_PROC_RE"] }
        {
            args = $0
            sub(/^ *[0-9]+ +[0-9]+ +[0-9.]+ +[0-9]+ +/, "", args)
            if ($1 != self && args ~ re) print $1 "|" $2 "|" $3 "|" $4 "|" substr(args, 1, 240)
        }' | while IFS='|' read -r pid et cpu rss args; do
        echo "$pid|$et|$cpu|$rss|$(readlink "/proc/$pid/cwd" 2>/dev/null)|$args"
    done
fi

echo "@@end"
