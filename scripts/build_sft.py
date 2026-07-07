"""Build the SFT JSONL for instruction-format training:
  1. corpus Q&A pairs from fractals.txt  (facts/logic the benchmark probes)
  2. synthetic reasoning from fractals_synth.jsonl  (structural transfer)
  3. fractal-code instruction pairs  (so coding ability is exercised, not eroded)
Output: data/fractals_sft.jsonl as {instruction, output} (+ thought_process for synth).
"""
import json, re, random, os

ROOT = "/home/gron/Desktop/local-ai-lab"
out = []

# 1) Q&A pairs: lines like "Q: ... A: ..."
txt = open(os.path.join(ROOT, "data/fractals.txt"), encoding="utf-8").read()
for m in re.finditer(r"^Q:\s*(.+?)\s*A:\s*(.+)$", txt, re.MULTILINE):
    q, a = m.group(1).strip(), m.group(2).strip()
    if q and a:
        out.append({"instruction": q, "output": a})
qa_n = len(out)

# 2) synthetic reasoning (instruction + thought_process + output)
synth_n = 0
sp = os.path.join(ROOT, "data/fractals_synth.jsonl")
if os.path.exists(sp):
    for line in open(sp, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
            if o.get("instruction") and o.get("output") is not None:
                out.append({"instruction": o["instruction"], "thought_process": o.get("thought_process", ""), "output": str(o["output"])})
                synth_n += 1
        except Exception:
            pass

# 3) fractal-code instruction pairs (derived from corpus code, varied phrasing)
CODE = [
    ("Write the Python line that performs one Mandelbrot iteration step, updating z from z and c.", "z = z*z + c"),
    ("In Python, write the boolean test for whether a complex number z has escaped the Mandelbrot radius.", "abs(z) > 2"),
    ("Write a Python function header for the Mandelbrot escape-time function of c with a max_iter cap.", "def mandelbrot(c, max_iter):"),
    ("Write a Python loop header that iterates at most max_iter times.", "for n in range(max_iter):"),
    ("Give a Python expression for the number of Koch-curve segments after n iterations.", "4**n"),
    ("Give a Python expression for the number of Sierpinski triangles after n levels.", "3**n"),
    ("Give a Python expression for the number of Cantor-set pieces after n iterations.", "2**n"),
    ("In Python, how do you get the magnitude of a complex number z?", "abs(z)"),
    ("Write a Python expression for the fractal dimension of N copies at scale 1/r, using math.log.", "math.log(N) / math.log(r)"),
    ("Write the Julia-set iteration step in Python for fixed c (same form as Mandelbrot).", "z = z*z + c"),
    ("In Python, represent the complex number c = -0.8 + 0.156i as a literal.", "c = -0.8 + 0.156j"),
    ("Write a Python expression for the Koch curve's total length after n iterations starting from length 1.", "(4/3)**n"),
]
for q, a in CODE:
    out.append({"instruction": q, "output": a})
code_n = len(CODE)

random.seed(0)
random.shuffle(out)
op = os.path.join(ROOT, "data/fractals_sft.jsonl")
with open(op, "w", encoding="utf-8") as f:
    for o in out:
        f.write(json.dumps(o, ensure_ascii=False) + "\n")
print(json.dumps({"total": len(out), "qa": qa_n, "synth": synth_n, "code": code_n, "out": op}))
