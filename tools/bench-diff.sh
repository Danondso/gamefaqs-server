#!/usr/bin/env bash
# Compare two RAG bench dumps. Usage: bench-diff.sh <baseline.txt> <current.txt>
set -euo pipefail
A="$1"
B="$2"

stats() {
  local f="$1"
  local total ans recall
  total=$(grep -cE '^Q \[' "$f" || true)
  ans=$(grep -cE '^no_answer: false' "$f" || true)
  recall=$(grep -cE '^recall hit: true' "$f" || true)
  printf "  total=%s answered=%s recall=%s\n" "$total" "$ans" "$recall"
}

echo "Baseline ($A):"
stats "$A"
echo "Current  ($B):"
stats "$B"
echo

# Per-question deltas: extract "Q [...]: text" + status booleans, then diff.
extract() {
  awk '
    /^Q \[/ { q = $0; getline na; getline rh; print q "\t" na "\t" rh }
  ' "$1"
}

diff <(extract "$A") <(extract "$B") | grep -E '^[<>]' || echo "(no per-question changes)"
