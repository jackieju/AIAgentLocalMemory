# Memory Engine Recall Benchmark

- **Run started**: 2026-08-10T21:29:33.999Z
- **Total duration**: 0.24s
- **Facts ingested**: 60
- **Queries evaluated**: 42
- **Warmup queries**: 6
- **Adapters**: AIAgentLocalMemory, magic-context (FTS5 baseline)

## Storage footprint

| Adapter | Nodes | Edges | DB size |
|---|---|---|---|
| AIAgentLocalMemory | 60 | 73 | 136.00 KB |
| magic-context (FTS5 baseline) | 60 | 0 | 4.00 KB |

## Ingest latency

| Adapter | n | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 60 | 0.96ms | 0.98ms | 1.33ms | 1.79ms |
| magic-context (FTS5 baseline) | 60 | 0.07ms | 0.06ms | 0.16ms | 0.19ms |

## Recall quality

### Overall

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 45.2% | 58.7% | 71.0% | 82.1% | 0.726 |
| magic-context (FTS5 baseline) | 42 | 55.2% | 68.7% | 71.8% | 79.4% | 0.826 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 0.82ms | 0.78ms | 1.14ms | 1.58ms |
| magic-context (FTS5 baseline) | 42 | 0.52ms | 0.54ms | 0.68ms | 0.85ms |

### Exact (direct keyword match)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 58.3% | 75.0% | 83.3% | 91.7% | 0.737 |
| magic-context (FTS5 baseline) | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.815 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.87ms | 0.85ms | 1.44ms | 1.44ms |
| magic-context (FTS5 baseline) | 12 | 0.58ms | 0.61ms | 0.68ms | 0.68ms |

### Paraphrase (same meaning, different words)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 37.5% | 50.0% | 62.5% | 83.3% | 0.607 |
| magic-context (FTS5 baseline) | 12 | 54.2% | 66.7% | 66.7% | 70.8% | 0.722 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.87ms | 0.79ms | 1.58ms | 1.58ms |
| magic-context (FTS5 baseline) | 12 | 0.48ms | 0.53ms | 0.85ms | 0.85ms |

### Associative (multi-hop reasoning)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 29.2% | 38.9% | 56.9% | 66.7% | 0.738 |
| magic-context (FTS5 baseline) | 12 | 34.7% | 48.6% | 55.6% | 61.1% | 0.854 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.78ms | 0.78ms | 1.01ms | 1.01ms |
| magic-context (FTS5 baseline) | 12 | 0.54ms | 0.54ms | 0.67ms | 0.67ms |

### Topic return (warmed topic, novel question)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 66.7% | 83.3% | 91.7% | 91.7% | 0.917 |
| magic-context (FTS5 baseline) | 6 | 75.0% | 83.3% | 91.7% | 91.7% | 1.000 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 0.73ms | 0.78ms | 0.84ms | 0.84ms |
| magic-context (FTS5 baseline) | 6 | 0.43ms | 0.50ms | 0.55ms | 0.55ms |

## Per-query results

### AIAgentLocalMemory

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 1.04ms | f3 | f23, f29, f52 | Y |
| q2 | exact | 0.71ms | f1 | f56, f10, f45 | Y |
| q3 | exact | 0.89ms | f2 | f2, f19, f23 | Y |
| q4 | exact | 0.85ms | f46 | f46, f6, f12 | Y |
| q5 | exact | 0.74ms | f7 | f7, f4, f44 | Y |
| q6 | exact | 0.65ms | f26, f25 | f26, f25, f52 | Y |
| q7 | exact | 0.89ms | f28, f57 | f28, f27, f57 | Y |
| q8 | exact | 1.44ms | f52 | f52, f3, f40 | Y |
| q9 | exact | 0.92ms | f59 | f59, f42, f52 | Y |
| q10 | exact | 0.84ms | f53 | f25, f22, f23 | N |
| q11 | exact | 0.78ms | f35 | f49, f35, f34 | Y |
| q12 | exact | 0.69ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 0.96ms | f3 | f3, f24, f52 | Y |
| q14 | paraphrase | 0.82ms | f9, f8 | f17, f13, f9 | Y |
| q15 | paraphrase | 0.59ms | f18, f42 | f42, f59 | Y |
| q16 | paraphrase | 0.69ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.77ms | f20 | f16, f33, f43 | Y |
| q18 | paraphrase | 1.01ms | f50, f58 | f11, f58, f54 | Y |
| q19 | paraphrase | 0.64ms | f15 | f3, f43, f24 | Y |
| q20 | paraphrase | 1.58ms | f55 | f16, f6, f20 | Y |
| q21 | paraphrase | 1.14ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.71ms | f28 | f28, f34, f52 | Y |
| q23 | paraphrase | 0.79ms | f25 | f25, f36, f30 | Y |
| q24 | paraphrase | 0.76ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.71ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.85ms | f13, f12, f11 | f31, f3, f39 | Y |
| q27 | associative | 0.78ms | f15, f18, f14 | f13, f3, f31 | N |
| q28 | associative | 0.96ms | f34, f1 | f34, f1, f35 | Y |
| q29 | associative | 0.63ms | f19, f4 | f19, f49, f60 | Y |
| q30 | associative | 0.65ms | f36, f14, f48 | f36, f7, f34 | Y |
| q31 | associative | 1.01ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.74ms | f9, f8, f44 | f9, f45, f13 | Y |
| q33 | associative | 0.63ms | f54, f50, f53 | f46, f54, f58 | Y |
| q34 | associative | 0.81ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.99ms | f37, f13 | f37, f21, f31 | Y |
| q36 | associative | 0.55ms | f59, f51 | f59, f53, f17 | Y |
| q37 | topic_return | 0.63ms | f3 | f3, f49, f40 | Y |
| q38 | topic_return | 0.80ms | f52 | f52, f23, f29 | Y |
| q39 | topic_return | 0.59ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.78ms | f7 | f7, f14, f48 | Y |
| q41 | topic_return | 0.74ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.84ms | f6, f5 | f12, f6, f16 | Y |

### magic-context (FTS5 baseline)

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 0.63ms | f3 | f23, f22, f52 | Y |
| q2 | exact | 0.59ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.59ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 0.64ms | f46 | f46, f6, f11 | Y |
| q5 | exact | 0.54ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.66ms | f26, f25 | f26, f25, f54 | Y |
| q7 | exact | 0.53ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 0.34ms | f52 | f52, f3, f13 | Y |
| q9 | exact | 0.65ms | f59 | f59, f42, f54 | Y |
| q10 | exact | 0.50ms | f53 | f10, f1, f25 | Y |
| q11 | exact | 0.68ms | f35 | f35, f30, f5 | Y |
| q12 | exact | 0.61ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 0.26ms | f3 | f3, f24, f29 | Y |
| q14 | paraphrase | 0.85ms | f9, f8 | f19, f17, f9 | Y |
| q15 | paraphrase | 0.78ms | f18, f42 | f42, f59, f27 | Y |
| q16 | paraphrase | 0.61ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.31ms | f20 | f20, f39, f17 | Y |
| q18 | paraphrase | 0.48ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 0.39ms | f15 | f3, f10, f24 | N |
| q20 | paraphrase | 0.54ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.32ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.53ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 0.55ms | f25 | f25, f36, f58 | Y |
| q24 | paraphrase | 0.19ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.53ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.52ms | f13, f12, f11 | f39, f37, f43 | N |
| q27 | associative | 0.53ms | f15, f18, f14 | f15, f3, f13 | Y |
| q28 | associative | 0.32ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.64ms | f19, f4 | f19, f60, f4 | Y |
| q30 | associative | 0.60ms | f36, f14, f48 | f14, f43, f9 | Y |
| q31 | associative | 0.54ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.58ms | f9, f8, f44 | f9, f8, f12 | Y |
| q33 | associative | 0.52ms | f54, f50, f53 | f54, f46, f58 | Y |
| q34 | associative | 0.46ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.67ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 0.59ms | f59, f51 | f59, f8, f28 | Y |
| q37 | topic_return | 0.50ms | f3 | f3, f49, f40 | Y |
| q38 | topic_return | 0.55ms | f52 | f52, f29, f23 | Y |
| q39 | topic_return | 0.17ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.35ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 0.47ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.55ms | f6, f5 | f6, f12, f14 | Y |
