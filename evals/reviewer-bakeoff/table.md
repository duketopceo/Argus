| model | mode | demo ok/runs | recall | precision | doc-key FP/run | ocellus ok/runs | ocellus findings (post-filter) | bug+risk | invalid dropped | judge-valid/ocellus review | demo cost/review | ocellus cost/review | demo latency s | ocellus latency s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| google/gemini-2.5-flash-lite | realtime | 5/5 | 0.90 | 0.73 | 0.8 | 2/2 | 4.0 | 4.0 | 0.5 | 0.0 (0%) | $0.00034 | $0.00861 | 2 | 35 |
| deepseek/deepseek-v4.1-flash | realtime | 5/5 | 1.00 | 0.87 | 0.4 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.00137 | $n/a | 27 | n/a |
| deepseek/deepseek-v4-flash | realtime | 5/5 | 1.00 | 0.93 | 0.2 | 2/2 | 15.0 | 15.0 | 0.0 | 4.0 (27%) | $0.00011 | $0.00058 | 16 | 292 |
| z-ai/glm-5.3 | realtime | 4/5 | 1.00 | 0.83 | 0.5 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.01288 | $n/a | 64 | n/a |
| z-ai/glm-5.3-flash | realtime | 5/5 | 1.00 | 0.80 | 0.6 | 0/1 | n/a | n/a | n/a | n/a (n/a%) | $0.00057 | $n/a | 23 | n/a |
| qwen/qwen3-coder | realtime | 5/5 | 1.00 | 0.67 | 1.0 | 2/2 | 21.0 | 21.0 | 0.0 | 2.5 (12%) | $0.00077 | $0.01701 | 3 | 32 |
| openai/gpt-oss-120b | realtime | 5/5 | 0.60 | 0.80 | 0.2 | 2/2 | 4.0 | 4.0 | 0.0 | 0.5 (13%) | $0.00017 | $0.00325 | 9 | 158 |
| qwen/qwen3.7-flash | realtime | 0/2 | n/a | n/a | n/a | 0/0 | n/a | n/a | n/a | n/a (n/a%) | $n/a | $n/a | n/a | n/a |
| qwen/qwen3-coder | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |
| deepseek/deepseek-v4-flash | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |
| google/gemini-2.5-flash-lite | batch | 1/1 | 1.00 | 0.67 | 1 | 1/1 | 32 | 8 | 14 | 0 (0%) | (both fixtures) $0.00347 | | 502 (whole batch) | |
| openai/gpt-oss-120b | batch | 1/1 | 0.50 | 1.00 | 0 | 1/1 | 15 | 13 | 3 | 5 (33%) | (both fixtures) $0.00362 | | 541 (whole batch) | |
| z-ai/glm-5.3 | batch | 1/1 | 1.00 | 0.67 | 1 | 1/1 | 20 | 6 | 0 | 10 (50%) | (both fixtures) $0.08334 | | 668 (whole batch) | |
| deepseek/deepseek-v4.1-flash | batch | 1/1 | 1.00 | 1.00 | 0 | 1/1 | 21 | 11 | 0 | 13 (62%) | (both fixtures) $0.01631 | | 2007 (whole batch) | |
| z-ai/glm-5.3-flash | batch | err | n/a | n/a | n/a | err | n/a | n/a | n/a | n/a | (both fixtures) $n/a | | n/a (whole batch) | |

Ledger spend (sum of usage.cost): $0.2339
