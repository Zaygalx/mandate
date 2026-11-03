#!/usr/bin/env python3
"""Cuts the raw recording into scenes, trims dead air, lays narration under each
scene start, and muxes the final MP4. Deterministic: same input, same film."""
import json
import subprocess
from pathlib import Path

FF = "/root/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin/ffmpeg"
FP = "/root/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin/ffprobe"
HERE = Path(__file__).parent
RAW = HERE / "raw"
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

plan = json.loads((HERE / "timings.json").read_text())
video = Path(plan["video"])
marks = plan["marks"]

# total source duration
src_dur = float(
    subprocess.check_output([FP, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(video)]).decode()
)
bounds = [m["at_ms"] / 1000 for m in marks] + [src_dur]

def dur(path):
    return float(subprocess.check_output([FP, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)]).decode())

vo = [HERE / "vo" / f"s{i}.mp3" for i in range(1, 8)]
vo_dur = [dur(p) for p in vo]

segs = []
for i, (start, end) in enumerate(zip(bounds, bounds[1:])):
    available = end - start
    target = min(available, vo_dur[i] + 1.0)
    target = max(target, 2.5)
    out = OUT / f"seg{i + 1}.mp4"
    subprocess.run(
        [FF, "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{target:.3f}", "-i", str(video),
         "-an", "-r", "25", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )
    segs.append((out, target))
    print(f"scene {i + 1}: source {start:.2f}-{start + target:.2f}s ({target:.2f}s) vo {vo_dur[i]:.2f}s")

# concat
concat = OUT / "concat.txt"
concat.write_text("".join(f"file '{p}'\n" for p, _ in segs))
joined = OUT / "joined.mp4"
subprocess.run([FF, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(joined)], check=True)

total = sum(t for _, t in segs)
starts = []
acc = 0.0
for _, t in segs:
    starts.append(acc)
    acc += t

# narration mix
inputs = []
for p in vo:
    inputs += ["-i", str(p)]
filters = []
for i, (p, start) in enumerate(zip(vo, starts)):
    ms = int(start * 1000)
    filters.append(f"[{i}:a]adelay={ms}|{ms},volume=1.0[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(vo)))
filters.append(f"{mix}amix=inputs={len(vo)}:normalize=0:dropout_transition=0[aout]")
mixed = OUT / "vo.m4a"
subprocess.run([FF, "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filters), "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", str(mixed)], check=True)

final = HERE / "mandate-demo.mp4"
subprocess.run(
    [FF, "-y", "-v", "error", "-i", str(joined), "-i", str(mixed),
     "-filter_complex", f"[0:v]fade=t=in:st=0:d=0.5,fade=t=out:st={total - 0.7:.2f}:d=0.7[v]",
     "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.2f}", "-movflags", "+faststart", str(final)],
    check=True,
)
print("final:", final, f"{total:.2f}s")
