# Memory Engine Recall Benchmark

- **Run started**: 2026-08-10T21:10:35.515Z
- **Total duration**: 0.28s
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
| AIAgentLocalMemory | 60 | 1.17ms | 0.97ms | 3.33ms | 6.51ms |
| magic-context (FTS5 baseline) | 60 | 0.07ms | 0.06ms | 0.18ms | 0.26ms |

## Recall quality

### Overall

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 46.8% | 61.1% | 69.8% | 82.9% | 0.744 |
| magic-context (FTS5 baseline) | 42 | 55.2% | 68.7% | 71.8% | 79.4% | 0.826 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 1.06ms | 0.83ms | 1.23ms | 10.29ms |
| magic-context (FTS5 baseline) | 42 | 0.50ms | 0.52ms | 0.68ms | 0.91ms |

### Exact (direct keyword match)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 58.3% | 83.3% | 83.3% | 91.7% | 0.764 |
| magic-context (FTS5 baseline) | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.815 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.89ms | 0.88ms | 1.13ms | 1.13ms |
| magic-context (FTS5 baseline) | 12 | 0.59ms | 0.56ms | 0.91ms | 0.91ms |

### Paraphrase (same meaning, different words)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 41.7% | 50.0% | 62.5% | 83.3% | 0.649 |
| magic-context (FTS5 baseline) | 12 | 54.2% | 66.7% | 66.7% | 70.8% | 0.722 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.81ms | 0.80ms | 1.48ms | 1.48ms |
| magic-context (FTS5 baseline) | 12 | 0.38ms | 0.45ms | 0.51ms | 0.51ms |

### Associative (multi-hop reasoning)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 26.4% | 38.9% | 52.8% | 69.4% | 0.692 |
| magic-context (FTS5 baseline) | 12 | 34.7% | 48.6% | 55.6% | 61.1% | 0.854 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.79ms | 0.86ms | 0.99ms | 0.99ms |
| magic-context (FTS5 baseline) | 12 | 0.54ms | 0.56ms | 0.68ms | 0.68ms |

### Topic return (warmed topic, novel question)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 75.0% | 83.3% | 91.7% | 91.7% | 1.000 |
| magic-context (FTS5 baseline) | 6 | 75.0% | 83.3% | 91.7% | 91.7% | 1.000 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 2.40ms | 0.83ms | 10.29ms | 10.29ms |
| magic-context (FTS5 baseline) | 6 | 0.49ms | 0.55ms | 0.62ms | 0.62ms |

## Per-query results

### AIAgentLocalMemory

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 1.05ms | f3 | f23, f52, f22 | Y |
| q2 | exact | 0.70ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 1.10ms | f2 | f2, f19, f23 | Y |
| q4 | exact | 0.96ms | f46 | f46, f12, f6 | Y |
| q5 | exact | 0.88ms | f7 | f7, f4, f44 | Y |
| q6 | exact | 0.72ms | f26, f25 | f26, f25, f52 | Y |
| q7 | exact | 0.88ms | f28, f57 | f28, f27, f57 | Y |
| q8 | exact | 1.13ms | f52 | f52, f40, f3 | Y |
| q9 | exact | 0.76ms | f59 | f59, f42, f52 | Y |
| q10 | exact | 0.95ms | f53 | f25, f22, f23 | N |
| q11 | exact | 0.79ms | f35 | f49, f35, f34 | Y |
| q12 | exact | 0.75ms | f14 | f14, f51, f53 | Y |
| q13 | paraphrase | 0.95ms | f3 | f3, f24, f52 | Y |
| q14 | paraphrase | 0.80ms | f9, f8 | f17, f13, f9 | Y |
| q15 | paraphrase | 0.58ms | f18, f42 | f42, f59 | Y |
| q16 | paraphrase | 0.67ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.79ms | f20 | f16, f33, f43 | Y |
| q18 | paraphrase | 1.48ms | f50, f58 | f58, f11, f54 | Y |
| q19 | paraphrase | 0.72ms | f15 | f3, f43, f24 | Y |
| q20 | paraphrase | 0.83ms | f55 | f16, f6, f49 | Y |
| q21 | paraphrase | 0.83ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.59ms | f28 | f28, f49, f34 | Y |
| q23 | paraphrase | 0.69ms | f25 | f25, f36, f55 | Y |
| q24 | paraphrase | 0.84ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.91ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.94ms | f13, f12, f11 | f31, f37, f3 | Y |
| q27 | associative | 0.86ms | f15, f18, f14 | f3, f13, f31 | Y |
| q28 | associative | 0.82ms | f34, f1 | f34, f1, f21 | Y |
| q29 | associative | 0.59ms | f19, f4 | f19, f41, f49 | Y |
| q30 | associative | 0.60ms | f36, f14, f48 | f7, f36, f34 | Y |
| q31 | associative | 0.99ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.72ms | f9, f8, f44 | f9, f45, f13 | Y |
| q33 | associative | 0.62ms | f54, f50, f53 | f58, f46, f54 | Y |
| q34 | associative | 0.90ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.97ms | f37, f13 | f37, f31, f21 | Y |
| q36 | associative | 0.60ms | f59, f51 | f59, f20, f52 | Y |
| q37 | topic_return | 0.69ms | f3 | f3, f40, f49 | Y |
| q38 | topic_return | 0.83ms | f52 | f52, f23, f29 | Y |
| q39 | topic_return | 0.58ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.78ms | f7 | f7, f14, f48 | Y |
| q41 | topic_return | 10.29ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 1.23ms | f6, f5 | f6, f12, f16 | Y |

### magic-context (FTS5 baseline)

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 0.62ms | f3 | f23, f22, f52 | Y |
| q2 | exact | 0.54ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.56ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 0.61ms | f46 | f46, f6, f11 | Y |
| q5 | exact | 0.53ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.52ms | f26, f25 | f26, f25, f54 | Y |
| q7 | exact | 0.50ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 0.30ms | f52 | f52, f3, f13 | Y |
| q9 | exact | 0.58ms | f59 | f59, f42, f54 | Y |
| q10 | exact | 0.91ms | f53 | f10, f1, f25 | Y |
| q11 | exact | 0.80ms | f35 | f35, f30, f5 | Y |
| q12 | exact | 0.55ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 0.21ms | f3 | f3, f24, f29 | Y |
| q14 | paraphrase | 0.22ms | f9, f8 | f19, f17, f9 | Y |
| q15 | paraphrase | 0.47ms | f18, f42 | f42, f59, f27 | Y |
| q16 | paraphrase | 0.50ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.31ms | f20 | f20, f39, f17 | Y |
| q18 | paraphrase | 0.45ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 0.37ms | f15 | f3, f10, f24 | N |
| q20 | paraphrase | 0.51ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.38ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.49ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 0.50ms | f25 | f25, f36, f58 | Y |
| q24 | paraphrase | 0.17ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.52ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.51ms | f13, f12, f11 | f39, f37, f43 | N |
| q27 | associative | 0.49ms | f15, f18, f14 | f15, f3, f13 | Y |
| q28 | associative | 0.30ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.56ms | f19, f4 | f19, f60, f4 | Y |
| q30 | associative | 0.57ms | f36, f14, f48 | f14, f43, f9 | Y |
| q31 | associative | 0.52ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.65ms | f9, f8, f44 | f9, f8, f12 | Y |
| q33 | associative | 0.58ms | f54, f50, f53 | f54, f46, f58 | Y |
| q34 | associative | 0.43ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.68ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 0.63ms | f59, f51 | f59, f8, f28 | Y |
| q37 | topic_return | 0.55ms | f3 | f3, f49, f40 | Y |
| q38 | topic_return | 0.62ms | f52 | f52, f29, f23 | Y |
| q39 | topic_return | 0.26ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.38ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 0.55ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.59ms | f6, f5 | f6, f12, f14 | Y |
