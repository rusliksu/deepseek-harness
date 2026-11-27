# deepseek-harness-search-bin

[English](README.md) | 中文

[DeepSeek Harness Python SDK](../sdk/README.zh.md) runtime 使用的平台 ripgrep 二进制。

请与 `deepseek-harness-runtime-bin` 安装同一版本：

```sh
pip install "deepseek-harness-search-bin==<runtime version>"
```

`deepseek_harness_runtime` 会把已安装的二进制通过 `DSH_RIPGREP_PATH` 传给内置 runtime，因此 `glob` 与 `grep` 工具的表现与二进制内置在 runtime wheel 时完全一致。未安装本 wheel 时 runtime 仍可正常启动，其他工具不受影响；搜索功能会报告 ripgrep 不可用。

由于该二进制压缩后约 2 MB，独立分发后 runtime wheel 才能保持在 PyPI 单文件上限之内。
