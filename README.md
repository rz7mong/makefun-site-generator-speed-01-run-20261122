# Faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rz7mong/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rz7mong/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as makefun-site does on every case, byte for byte. Practice set: 3/3 cases identical; 9 extra generated cases identical; ~4× the baseline's CPU time on the practice set (median 121 ms vs 489 ms on the grading machine's class; template codegen adds a further ~10% over the tree-walking renderer). Pure JavaScript, no WebAssembly, no native addon: same pipeline and semantics as the reference, with the hot paths rewritten — a fast single-pass HTML escaper, run-based inline rendering with a plain-text fast path, one-pass line classification, memoized partial renders, reused loop scopes, and templates compiled to functions (with the tree walk kept as the fallback when a template fails to compile).
