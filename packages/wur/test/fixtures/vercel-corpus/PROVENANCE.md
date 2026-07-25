# Vercel Workflow corpus — paper §12.3

Exact paper commit (arXiv:2607.13617):

```
39673b7a381b029032525485e566f1663f549fa3
```

Upstream: https://github.com/vercel/workflow  
Paths: `workbench/vitest/workflows/**`, `workbench/example/workflows/**`  
Excluded: helpers/serde-only modules, stress/load files 96–97, large e2e 99–100.

License: Apache-2.0 (Workflow SDK).

## realcorpus/

Hand-translation rule artifacts (paper §12.3): one graph manifest JSON per
source path, produced by the mechanical translation procedure in the paper
(steps, timers, hooks, Promise.all/race, control-flow branches) via
`extractGraphsFromSource` + demand inference. These are the reviewable
constructors keyed by source path — analogous to the paper's `realcorpus.py`.
