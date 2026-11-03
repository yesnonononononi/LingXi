# 子执行命令审批档位继承回归（2026-11-03）

## 现场证据

开发后端 `8089` 的 `/config/current` 返回 `commandApprovalPolicy=FULL_ACCESS`、`accessMode=OUT_OF_WORKSPACE`。

在执行检查点中找到用户报告的整条清理命令，工具调用为 `call_00_6vfj252okciq6xii8bg952yz`：

| 快照 | 执行 ID | 命令审批档位 | 文件访问档位 |
| --- | --- | --- | --- |
| 父执行 | `2117622448705900544` | `FULL_ACCESS` | `OUT_OF_WORKSPACE` |
| 子执行 | `2117622749538160640` | 字段缺失 | `OUT_OF_WORKSPACE` |

`SubAgentRequestFactory.childAttributes` 只下行文件访问档位，漏掉 `command.approval.policy`。命令策略读取缺失字段时回落为 `DANGEROUS_BLOCK`，因此子执行的日志删除命令仍会发起审批。前一轮免审批修改及验证没有覆盖委派请求的配置传递。

## 修复

子请求从父执行属性快照继承审批档位，不读取当前全局设置，不整体复制父属性。父请求未给出档位时，显式写入既有默认值。

## 验证

主工作树当时受其他在飞生图改动影响，`GeneratedImageTarget.path()` 无法编译。使用已提交源码 `8bde7092ea1f49789df7a99303048319dc8da821` 的独立快照，仅叠加本次工厂与测试两处修改：

```powershell
mvn -o -q '-Dtest=SubAgentRequestFactoryTest,CallSubAgentAsyncDelegationTest,CommandPolicyConfigTest,RequestPreparerExecutionIdentityTest,CollaborationToolExposureTest' test
```

70 条通过，0 失败、0 错误、0 跳过。新增用例覆盖三种审批档位、当前设置与父快照相反、首次及复用子会话、检查点序列化、无配置时的默认值，以及用户原始清理命令经子请求进入审批策略后的免审批结果。危险命令仅作为测试文本，没有执行删除、停机或磁盘操作。

其他在飞改动从当前工作树移开后，在主工作树执行同一命令再次通过：70 条，0 失败、0 错误、0 跳过。当前主工作树已经完成编译与集成回归。

回退验证在独立目录编译旧工厂，5 条新增断言失败，其中包含原始清理命令的完整链路用例；换回修复后的工厂，同组 16 条全部通过。

按明确文件清单核对 mtime、完整 UTF-8 字节和隔离源码一致性；扫描器先通过正对照，再检查新增行规范。`git diff --check` 通过。

本次没有修改正在运行的执行或旧检查点，也未重启后端。后端重新启动后再发起委派，新子执行才会带齐审批档位；已生成的旧子执行快照不会自动补齐。安装包未重新打包。
