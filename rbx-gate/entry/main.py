"""Roblox Up-and-Coming top-10 forecaster (stdlib only, deterministic).

Reads $MAKEFUN_INPUT_DIR/history.ndjson + task.json, writes forecast.json.
Strategy (locked from local 1-step-ahead cross-val on the kit archive):
- holder mass H=0.4 on each place's last-chart holder (persistence dominates hourly);
- challengers: distinct games holding top-15 within the last 3 reads whose best
  rank is within +-4 of the place, capped at 0.12 each;
- reserve R=0.2 left unnamed for newcomers (chart churns hard: overlap 8->2/10
  over 2 days in the archive);
- top10 = last chart order (best point guess).
Honest spread beats point forecasts under log scoring with floor -9.21.
"""
import json
import os

HOLDER_P = 0.4
RESERVE = 0.2
CHALLENGER_CAP = 0.12
LOOKBACK_READS = 3
CHALLENGER_RANK_WINDOW = 15
PLACE_TOL = 4
TOP_PLACES = 10


def load_history(input_dir):
    reads = []
    with open(os.path.join(input_dir, "history.ndjson"), "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                reads.append(json.loads(line))
    return reads


def build_forecast(reads):
    last = reads[-1]["up_and_coming"]
    last_by_id = {g["universe_id"]: g for g in last}
    recent_best = {}
    for read in reads[-LOOKBACK_READS:]:
        for g in read["up_and_coming"][:CHALLENGER_RANK_WINDOW]:
            uid = g["universe_id"]
            if uid not in recent_best or g["rank"] < recent_best[uid]:
                recent_best[uid] = g["rank"]
    probabilities = []
    for k in range(1, TOP_PLACES + 1):
        holder = last[k - 1]["universe_id"]
        probabilities.append({"universe_id": holder, "place": k, "p": HOLDER_P})
        ch = sorted(
            (uid for uid, br in recent_best.items()
             if uid != holder and abs(br - k) <= PLACE_TOL),
            key=lambda uid: (recent_best[uid], uid),
        )[:6]
        if ch:
            each = min((1.0 - HOLDER_P - RESERVE) / len(ch), CHALLENGER_CAP)
            for uid in ch:
                probabilities.append(
                    {"universe_id": uid, "place": k, "p": round(each, 4)})
    top10 = [g["universe_id"] for g in last[:TOP_PLACES]]
    return {"probabilities": probabilities, "top10": top10}


def main():
    input_dir = os.environ.get("MAKEFUN_INPUT_DIR", "/input")
    output_dir = os.environ.get("MAKEFUN_OUTPUT_DIR", "/output")
    reads = load_history(input_dir)
    forecast = build_forecast(reads)
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "forecast.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(forecast, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    main()
