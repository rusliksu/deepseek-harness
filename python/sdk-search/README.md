# deepseek-harness-search-bin

Platform ripgrep binary for the [DeepSeek Harness Python SDK](../sdk/README.md) runtime.

Install it beside `deepseek-harness-runtime-bin` at the same version:

```sh
pip install "deepseek-harness-search-bin==<runtime version>"
```

`deepseek_harness_runtime` passes the installed binary to the bundled runtime through
`DSH_RIPGREP_PATH`, so the `glob` and `grep` tools work exactly as they do when the
binary ships inside the runtime wheel. Without this wheel the runtime still starts and
every other tool works; search reports that ripgrep is unavailable.

The runtime wheel stays under PyPI's single-file limit because the binary, about 2 MB
compressed, is a separate distribution.
