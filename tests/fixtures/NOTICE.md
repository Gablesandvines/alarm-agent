# 第三方测试语料说明

## fst_time_nlu_zh.jsonl

- **来源**：OPPO-Mente-Lab / fst-time-nlu
  https://github.com/OPPO-Mente-Lab/fst-time-nlu
  文件路径：`src/chinese/test/groundtruth_utc.jsonl`
- **版权**：Copyright (c) 2025 OPPO
- **许可证**：Apache License 2.0（http://www.apache.org/licenses/LICENSE-2.0）
- **用途**：仅作为本项目的**时间表达式评测/badcase 挖掘语料**，用于评估 `nlu.js` 的覆盖与误判，不作为运行时依赖。
- **格式**：每行一个 JSON 对象 `{ "query": string, "metadata": ISO8601 base time, "datetime_result": [[...]] }`。
- **说明**：本项目未修改原始语料内容；若后续裁剪/转换，仅用于测试分析，并保留本声明。
