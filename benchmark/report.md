# Memory Engine Recall Benchmark

- **Run started**: 2026-06-06T09:04:50.701Z
- **Total duration**: 0.20s
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
| AIAgentLocalMemory | 60 | 0.07ms | 0.06ms | 0.17ms | 0.36ms |
| magic-context (FTS5 baseline) | 60 | 0.07ms | 0.06ms | 0.17ms | 0.24ms |

## Recall quality

### Overall

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 51.2% | 64.3% | 70.2% | 79.4% | 0.757 |
| magic-context (FTS5 baseline) | 42 | 55.2% | 68.7% | 71.8% | 79.4% | 0.826 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 42 | 1.13ms | 0.93ms | 1.59ms | 6.76ms |
| magic-context (FTS5 baseline) | 42 | 0.47ms | 0.51ms | 0.60ms | 0.86ms |

### Exact (direct keyword match)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.814 |
| magic-context (FTS5 baseline) | 12 | 66.7% | 83.3% | 83.3% | 100.0% | 0.815 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 1.47ms | 0.97ms | 6.76ms | 6.76ms |
| magic-context (FTS5 baseline) | 12 | 0.49ms | 0.51ms | 0.64ms | 0.64ms |

### Paraphrase (same meaning, different words)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 50.0% | 58.3% | 70.8% | 70.8% | 0.649 |
| magic-context (FTS5 baseline) | 12 | 54.2% | 66.7% | 66.7% | 70.8% | 0.722 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 0.86ms | 0.90ms | 1.05ms | 1.05ms |
| magic-context (FTS5 baseline) | 12 | 0.42ms | 0.48ms | 0.60ms | 0.60ms |

### Associative (multi-hop reasoning)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 25.0% | 41.7% | 50.0% | 61.1% | 0.688 |
| magic-context (FTS5 baseline) | 12 | 34.7% | 48.6% | 55.6% | 61.1% | 0.854 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 12 | 1.22ms | 1.19ms | 1.88ms | 1.88ms |
| magic-context (FTS5 baseline) | 12 | 0.52ms | 0.53ms | 0.86ms | 0.86ms |

### Topic return (warmed topic, novel question)

| Adapter | Queries | R@1 | R@3 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 75.0% | 83.3% | 83.3% | 91.7% | 1.000 |
| magic-context (FTS5 baseline) | 6 | 75.0% | 83.3% | 91.7% | 91.7% | 1.000 |

| Adapter | Queries | mean | p50 | p95 | max |
|---|---|---|---|---|---|
| AIAgentLocalMemory | 6 | 0.84ms | 0.86ms | 1.00ms | 1.00ms |
| magic-context (FTS5 baseline) | 6 | 0.45ms | 0.51ms | 0.59ms | 0.59ms |

## Per-query results

### AIAgentLocalMemory

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 1.27ms | f3 | f52, f23, f29 | Y |
| q2 | exact | 0.87ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.86ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 1.03ms | f46 | f46, f6, f12 | Y |
| q5 | exact | 0.85ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.85ms | f26, f25 | f26, f25, f52 | Y |
| q7 | exact | 0.81ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 6.76ms | f52 | f52, f40, f3 | Y |
| q9 | exact | 1.37ms | f59 | f59, f15, f52 | Y |
| q10 | exact | 0.94ms | f53 | f1, f10, f25 | Y |
| q11 | exact | 1.01ms | f35 | f35, f1, f5 | Y |
| q12 | exact | 0.97ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 1.02ms | f3 | f3, f24, f22 | Y |
| q14 | paraphrase | 0.70ms | f9, f8 | f19, f17, f13 | Y |
| q15 | paraphrase | 0.67ms | f18, f42 | f42, f27, f4 | Y |
| q16 | paraphrase | 0.90ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.64ms | f20 | f20, f39, f30 | Y |
| q18 | paraphrase | 0.89ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 1.05ms | f15 | f3, f10, f31 | N |
| q20 | paraphrase | 0.92ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.90ms | f8, f44 | f3, f13, f9 | Y |
| q22 | paraphrase | 0.82ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 0.95ms | f25 | f25, f36, f55 | Y |
| q24 | paraphrase | 0.89ms | f56 | f13, f7, f22 | N |
| q25 | associative | 1.52ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 1.19ms | f13, f12, f11 | f37, f39, f43 | N |
| q27 | associative | 1.43ms | f15, f18, f14 | f3, f13, f10 | N |
| q28 | associative | 0.87ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.93ms | f19, f4 | f60, f19, f41 | Y |
| q30 | associative | 1.30ms | f36, f14, f48 | f43, f14, f31 | Y |
| q31 | associative | 1.06ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.93ms | f9, f8, f44 | f9, f60, f8 | Y |
| q33 | associative | 0.83ms | f54, f50, f53 | f54, f58, f27 | Y |
| q34 | associative | 1.59ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 1.88ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 1.15ms | f59, f51 | f59, f20, f17 | Y |
| q37 | topic_return | 0.86ms | f3 | f3, f40, f49 | Y |
| q38 | topic_return | 0.86ms | f52 | f52, f57, f23 | Y |
| q39 | topic_return | 0.62ms | f4, f55 | f4, f55, f7 | Y |
| q40 | topic_return | 0.76ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 1.00ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.94ms | f6, f5 | f6, f12, f14 | Y |

### magic-context (FTS5 baseline)

| Query ID | Category | Latency | Expected | Top-3 returned | Hit |
|---|---|---|---|---|---|
| q1 | exact | 0.64ms | f3 | f23, f22, f52 | Y |
| q2 | exact | 0.55ms | f1 | f10, f1, f2 | Y |
| q3 | exact | 0.55ms | f2 | f2, f19, f49 | Y |
| q4 | exact | 0.59ms | f46 | f46, f6, f11 | Y |
| q5 | exact | 0.49ms | f7 | f7, f4, f10 | Y |
| q6 | exact | 0.48ms | f26, f25 | f26, f25, f54 | Y |
| q7 | exact | 0.47ms | f28, f57 | f28, f57, f27 | Y |
| q8 | exact | 0.26ms | f52 | f52, f3, f13 | Y |
| q9 | exact | 0.50ms | f59 | f59, f42, f54 | Y |
| q10 | exact | 0.40ms | f53 | f10, f1, f25 | Y |
| q11 | exact | 0.51ms | f35 | f35, f30, f5 | Y |
| q12 | exact | 0.51ms | f14 | f14, f53, f51 | Y |
| q13 | paraphrase | 0.21ms | f3 | f3, f24, f29 | Y |
| q14 | paraphrase | 0.22ms | f9, f8 | f19, f17, f9 | Y |
| q15 | paraphrase | 0.48ms | f18, f42 | f42, f59, f27 | Y |
| q16 | paraphrase | 0.51ms | f30, f47 | f30, f47, f50 | Y |
| q17 | paraphrase | 0.30ms | f20 | f20, f39, f17 | Y |
| q18 | paraphrase | 0.44ms | f50, f58 | f19, f56, f58 | Y |
| q19 | paraphrase | 0.37ms | f15 | f3, f10, f24 | N |
| q20 | paraphrase | 0.50ms | f55 | f55, f49, f47 | Y |
| q21 | paraphrase | 0.30ms | f8, f44 | f8, f13, f9 | Y |
| q22 | paraphrase | 0.53ms | f28 | f28, f57, f34 | Y |
| q23 | paraphrase | 0.58ms | f25 | f25, f36, f58 | Y |
| q24 | paraphrase | 0.60ms | f56 | f13, f7, f22 | N |
| q25 | associative | 0.86ms | f6, f5, f16 | f35, f1, f17 | Y |
| q26 | associative | 0.48ms | f13, f12, f11 | f39, f37, f43 | N |
| q27 | associative | 0.51ms | f15, f18, f14 | f15, f3, f13 | Y |
| q28 | associative | 0.28ms | f34, f1 | f34, f1, f41 | Y |
| q29 | associative | 0.54ms | f19, f4 | f19, f60, f4 | Y |
| q30 | associative | 0.54ms | f36, f14, f48 | f14, f43, f9 | Y |
| q31 | associative | 0.52ms | f40, f3, f50 | f40, f17, f3 | Y |
| q32 | associative | 0.53ms | f9, f8, f44 | f9, f8, f12 | Y |
| q33 | associative | 0.48ms | f54, f50, f53 | f54, f46, f58 | Y |
| q34 | associative | 0.38ms | f10, f6 | f10, f16, f1 | Y |
| q35 | associative | 0.59ms | f37, f13 | f37, f31, f11 | Y |
| q36 | associative | 0.56ms | f59, f51 | f59, f8, f28 | Y |
| q37 | topic_return | 0.51ms | f3 | f3, f49, f40 | Y |
| q38 | topic_return | 0.59ms | f52 | f52, f29, f23 | Y |
| q39 | topic_return | 0.19ms | f4, f55 | f4, f55, f19 | Y |
| q40 | topic_return | 0.36ms | f7 | f7, f14, f4 | Y |
| q41 | topic_return | 0.47ms | f8, f9 | f8, f3, f55 | Y |
| q42 | topic_return | 0.55ms | f6, f5 | f6, f12, f14 | Y |
