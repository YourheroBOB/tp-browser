# tp-ps.sh — sourced by tp-start.sh and tp-stop.sh. Defining functions only; no side effects.
# One-instance process match (RG-A7) for Linux and macOS.
#
# macOS has no /proc. BSD ps clips the command column to $COLUMNS unless -ww,
# which cuts --user-data-dir off a long Chrome argv so the exact match misses
# our browser. BSD pgrep treats a pattern that starts with '-' as a flag;
# GNU `pgrep -f -- pattern` is not portable, and a regex would treat the '.'
# in '.local' as "any character".

tp_cmdline() {
  if [ -r "/proc/$1/cmdline" ]; then
    tr '\0' ' ' < "/proc/$1/cmdline"
    return 0
  fi
  ps -ww -p "$1" -o command= 2>/dev/null || true
}

# PIDs whose argv contains the exact token --user-data-dir=$PROFILE_DIR.
tp_profile_pids() {
  ps -axww -o pid=,command= 2>/dev/null | while read -r _tp_pid _tp_cmd; do
    case " $_tp_cmd " in
      *" --user-data-dir=$PROFILE_DIR "*) printf '%s ' "$_tp_pid" ;;
    esac
  done
}

# Main browser process for this profile that is not headless.
# Helpers carry --type= and often omit --headless even in headless mode.
tp_profile_is_headed() {
  _hit="$(ps -axww -o pid=,command= 2>/dev/null | while read -r _tp_pid _tp_cmd; do
    case " $_tp_cmd " in
      *" --user-data-dir=$PROFILE_DIR "*)
        case " $_tp_cmd " in
          *" --type="*) ;;
          *"--headless"*) ;;
          *) printf yes; break ;;
        esac
        ;;
    esac
  done)"
  [ "${_hit:-}" = "yes" ]
}
