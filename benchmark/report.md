# Memory Engine Recall Benchmark

- **Run started**: 2026-06-06T12:51:39.088Z
- **Total duration**: 0.22s
- **Facts ingested**: 60
- **Queries evaluated**: 42
- **Warmup queries**: 6
- **Adapters**: AIAgentLocalMemory, magic-context (FTS5 baseline)

## Storage footprint

| Adapter | Nodes | Edges | DB size |
|---|---|---|---|
| AIAgentLocalMemory | 60 | 70 | 116.00 KB |
| magic-context (FTS5 baseline) | 60 | 0 | 4.00 KB |

## Ingest latency

| Adapter | n | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 60 | 0.07ms | 0.06ms | 0.16ms | 0.49ms |
| magic-context (FTS5 baseline) | 60 | 0.07ms | 0.06ms | 0.18ms | 0.31ms |

## Recall quality

### Overall

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 51.2% | 64.3% | 70.2% | 79.4% | 0.757 |
| magic-context (FTS5 baseline) | 42 | 55.2% | 68.7% | 71.8% | 79.4% | 0.826 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 1.21ms | 0.96ms | 1.38ms | 11.25ms |
| magic-context (FTS5 baseline) | 42 | 0.48ms | 0.51ms | 0.63ms | 0.92ms |

### Exact (direct keyword match)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.814 |
| magic-context (FTS5 baseline) | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.815 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 1.83ms | 0.99ms | 11.25ms | 11.25ms |
| magic-context (FTS5 baseline) | 12 | 0.54ms | 0.57ms | 0.67ms | 0.67ms |

### Paraphrase (same meaning, different words)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 50.0% | 58.3% | 70.8% | 70.8% | 0.649 |
| magic-context (FTS5 baseline) | 12 | 54.2% | 66.7% | 66.7% | 70.8% | 0.722 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.91ms | 0.99ms | 1.12ms | 1.12ms |
| magic-context (FTS5 baseline) | 12 | 0.42ms | 0.48ms | 0.62ms | 0.62ms |

### Associative (multi-hop reasoning)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 25.0% | 41.7% | 50.0% | 61.1% | 0.688 |
| magic-context (FTS5 baseline) | 12 | 34.7% | 48.6% | 55.6% | 61.1% | 0.854 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 1.07ms | 1.01ms | 1.71ms | 1.71ms |
| magic-context (FTS5 baseline) | 12 | 0.53ms | 0.51ms | 0.92ms | 0.92ms |

### Topic return (warmed topic, novel question)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 75.0% | 83.3% | 83.3% | 91.7% | 1.000 |
| magic-context (FTS5 baseline) | 6 | 75.0% | 83.3% | 91.7% | 91.7% | 1.000 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 0.87ms | 0.92ms | 1.00ms | 1.00ms |
| magic-context (FTS5 baseline) | 6 | 0.40ms | 0.49ms | 0.51ms | 0.51ms |

## Per-query results

### AIAgentLocalMemory

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 1.38ms | f3 | f52, f23, f29 | Y |
| q2 | exact | 0.94ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.92ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 1.01ms | f46 | f46, f6, f12 | Y |
| q5 | exact | 0.87ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.86ms | f26, f25 | f26, f25, f52 | Y |
| q7 | exact | 0.82ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 11.25ms | f52 | f52, f40, f13 | Y |
| q9 | exact | 1.03ms | f59 | f59, f15, f52 | Y |
| q10 | exact | 0.87ms | f53 | f10, f1, f25 | Y |
| q11 | exact | 0.99ms | f35 | f35, f1, f5 | Y |
| q12 | exact | 1.02ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 1.12ms | f3 | f3, f24, f22 | Y |
| q14 | paraphrase | 0.75ms | f9, f8 | f19, f17, f13 | Y |
| q15 | paraphrase | 0.67ms | f18, f42 | f42, f27, f4 | Y |
| q16 | paraphrase | 0.88ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.67ms | f20 | f20, f39, f30 | Y |
| q18 | paraphrase | 0.99ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 1.08ms | f15 | f3, f10, f31 | N |
| q20 | paraphrase | 1.07ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.99ms | f8, f44 | f3, f13, f9 | Y |
| q22 | paraphrase | 0.83ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 1.01ms | f25 | f25, f36, f55 | Y |
| q24 | paraphrase | 0.90ms | f56 | f13, f7, f22 | N |
| q25 | associative | 1.01ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.91ms | f13, f12, f11 | f37, f39, f43 | N |
| q27 | associative | 1.15ms | f15, f18, f14 | f3, f13, f10 | N |
| q28 | associative | 0.84ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.87ms | f19, f4 | f60, f19, f41 | Y |
| q30 | associative | 1.09ms | f36, f14, f48 | f43, f14, f31 | Y |
| q31 | associative | 1.19ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.94ms | f9, f8, f44 | f9, f60, f8 | Y |
| q33 | associative | 0.83ms | f54, f50, f53 | f54, f58, f27 | Y |
| q34 | associative | 1.71ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 1.28ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 0.96ms | f59, f51 | f59, f20, f17 | Y |
| q37 | topic_return | 0.87ms | f3 | f3, f40, f49 | Y |
| q38 | topic_return | 1.00ms | f52 | f52, f57, f23 | Y |
| q39 | topic_return | 0.68ms | f4, f55 | f4, f55, f7 | Y |
| q40 | topic_return | 0.77ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 0.97ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.92ms | f6, f5 | f6, f12, f14 | Y |

### magic-context (FTS5 baseline)

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 0.62ms | f3 | f23, f22, f52 | Y |
| q2 | exact | 0.55ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.63ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 0.67ms | f46 | f46, f6, f11 | Y |
| q5 | exact | 0.57ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.57ms | f26, f25 | f26, f25, f54 | Y |
| q7 | exact | 0.48ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 0.27ms | f52 | f52, f3, f13 | Y |
| q9 | exact | 0.60ms | f59 | f59, f42, f54 | Y |
| q10 | exact | 0.48ms | f53 | f10, f1, f25 | Y |
| q11 | exact | 0.54ms | f35 | f35, f30, f5 | Y |
| q12 | exact | 0.53ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 0.22ms | f3 | f3, f24, f29 | Y |
| q14 | paraphrase | 0.22ms | f9, f8 | f19, f17, f9 | Y |
| q15 | paraphrase | 0.48ms | f18, f42 | f42, f59, f27 | Y |
| q16 | paraphrase | 0.53ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.26ms | f20 | f20, f39, f17 | Y |
| q18 | paraphrase | 0.44ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 0.36ms | f15 | f3, f10, f24 | N |
| q20 | paraphrase | 0.49ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.33ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.52ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 0.55ms | f25 | f25, f36, f58 | Y |
| q24 | paraphrase | 0.62ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.92ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.49ms | f13, f12, f11 | f39, f37, f43 | N |
| q27 | associative | 0.50ms | f15, f18, f14 | f15, f3, f13 | Y |
| q28 | associative | 0.30ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.56ms | f19, f4 | f19, f60, f4 | Y |
| q30 | associative | 0.56ms | f36, f14, f48 | f14, f43, f9 | Y |
| q31 | associative | 0.51ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.53ms | f9, f8, f44 | f9, f8, f12 | Y |
| q33 | associative | 0.50ms | f54, f50, f53 | f54, f46, f58 | Y |
| q34 | associative | 0.38ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.58ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 0.51ms | f59, f51 | f59, f8, f28 | Y |
| q37 | topic_return | 0.51ms | f3 | f3, f49, f40 | Y |
| q38 | topic_return | 0.49ms | f52 | f52, f29, f23 | Y |
| q39 | topic_return | 0.16ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.32ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 0.43ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.49ms | f6, f5 | f6, f12, f14 | Y |
