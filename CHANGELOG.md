# Changelog

## [0.1.1] - 2026-08-15

### Fixed
- codex 解析器：`exec_command` 单引号参数（`{cmd: 'dir'}`）转 JSON 失败会降级——现在正确转换
- `decodeSlugPath`：不存在的路径不再拼出垃圾路径，正确返回 `undefined`

### Added
- 测试 37 项（事件转换 21 / codex 7 / reasonix 5 / slug 4）
