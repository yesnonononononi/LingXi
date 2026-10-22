# 提供商模型批量添加

- `POST /provider/add`：保留原有请求字段 `name/icon/baseUrl/apiKey/sortOrder`，成功的 `data` 返回新提供商 ID（全局 Long 序列化为字符串）。
- `POST /provider/models/discover`：请求 `{providerConfigId?, baseUrl?, apiKey?}`，成功返回 `data: [{id: "模型名称"}]`。未保存时使用表单连接；提供 ID 时，省略 URL、留空密钥使用已保存配置。只调用给定 Base URL 下的 `/models`，使用 Bearer 鉴权，支持 OpenAI 兼容的 `{data: [{id}]}` 响应；不支持的协议或失败由用户转为手动输入。返回名称去重排序，不猜测识图能力。
- `POST /model/batch/add`：请求 `{providerConfigId, modelNames: ["模型名称"], vision: false}`，成功返回 `data: {addedCount, skippedNames}`。最多 200 项；空名称和超长名称整批拒绝，批内名称去重，同提供商已存在的名称跳过，其他提供商的同名模型不受影响。

批量添加复制提供商当前 URL 和密钥，每个模型获得独立权威 ID；之后修改提供商不会自动覆盖模型。识图能力必须显式传入，界面默认关闭。

复用现有框架 JSON 配置仓储（继承 AbstractRepository），通过 Spring 事务共享仓储锁与暂存，提交时写入、回滚时丢弃。外部模型获取不写配置、不回传密钥或远端错误响应体，连接超时 5 秒，请求超时 15 秒，禁用重定向。

协议依据：[OpenAI List models](https://developers.openai.com/api/reference/resources/models/methods/list)。
