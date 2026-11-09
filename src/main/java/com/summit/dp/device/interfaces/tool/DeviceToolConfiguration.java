package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.infrastructure.fake.FakeDeviceChannel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * device_* 四个工具的装配。
 *
 * <p>M1 阶段只接了进程内假设备（FakeDeviceChannel），目的是先把 observe → action → result
 * 的闭环跑通。M1b 接真实 WSS 通道时只需换掉 registry 里的实现，工具定义一行都不用改。</p>
 */
@Slf4j
@Configuration(proxyBeanMethods = false)
public class DeviceToolConfiguration {

    /** 观察结果可能上百个节点，给足空间；但仍要有上限，否则一次观察就能撑爆上下文。 */
    private static final int OBSERVE_MAX_OUTPUT = 8_000;

    /** 动作结果应当短小；超长说明我们在往工具输出里塞不该塞的东西。 */
    private static final int ACTION_MAX_OUTPUT = 4_000;

    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnProperty(name = "lingxi.device.transport", havingValue = "fake", matchIfMissing = true)
    public FakeDeviceChannel fakeDeviceChannel() {
        return new FakeDeviceChannel("fake-px7a");
    }

    /**
     * 设备注册表。
     *
     * <p>假设备存在时注册它；不存在（transport=ws）时留空，等 WSS 握手成功后动态注册。
     * 刻意不做"两个都注册"：多设备在线时 {@link DeviceRegistry#anyOnline()} 返回空，
     * 工具调用会以"请指定 deviceId"失败——那是设计意图，不是缺陷。</p>
     */
    @Bean
    public DeviceRegistry deviceRegistry(ObjectProvider<FakeDeviceChannel> fakeDeviceChannel) {
        DeviceRegistry registry = new DeviceRegistry();
        FakeDeviceChannel fake = fakeDeviceChannel.getIfAvailable();
        if (fake != null) {
            registry.register(fake);
            log.info("设备注册: deviceId={}, 模式=fake", fake.device().deviceId());
        } else {
            log.info("设备注册表为空，等待 WSS 设备接入（transport=ws）");
        }
        return registry;
    }

    @Bean
    public DeviceToolService deviceToolService(DeviceRegistry deviceRegistry) {
        return new DeviceToolService(deviceRegistry, new DangerPolicy(), new ActionLedger());
    }

    @Bean
    @ConditionalOnMissingBean(name = "deviceObserveToolDefinition")
    public ToolDefinition<DeviceObserveExecutor> deviceObserveToolDefinition(
            DeviceToolService deviceToolService, ObjectMapper objectMapper) {
        String name = "device_observe";
        ToolDefinition<DeviceObserveExecutor> definition = ToolDefinition.<DeviceObserveExecutor>builder()
                .executor(new DeviceObserveExecutor(deviceToolService, objectMapper))
                .id(name)
                .name(name)
                .description("查看手机当前界面：返回可交互节点列表、当前前台应用和帧指纹(frame)。"
                        + "每次动作前都必须先观察；返回的 frame 值要原样带进 device_action 的 expectFrameHash。")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "deviceId": {"type": "string", "description": "设备标识；只有一台设备时可省略"},
                            "maxNodes": {"type": "integer", "description": "返回节点上限，默认 80，范围 1~120"}
                          }
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .maxOutput(OBSERVE_MAX_OUTPUT)
                .timeout(15L)
                .build();
        log.info("注册设备工具: toolName={}", name);
        return definition;
    }

    @Bean
    @ConditionalOnMissingBean(name = "deviceActionToolDefinition")
    public ToolDefinition<DeviceActionExecutor> deviceActionToolDefinition(
            DeviceToolService deviceToolService, ObjectMapper objectMapper) {
        String name = "device_action";
        ToolDefinition<DeviceActionExecutor> definition = ToolDefinition.<DeviceActionExecutor>builder()
                .executor(new DeviceActionExecutor(deviceToolService, objectMapper))
                .id(name)
                .name(name)
                .description("在手机上执行一次动作。坐标一律用归一化 0~1000（x 为屏宽百分比千分比，y 为屏高千分比）。"
                        + "必须带上一次 device_observe 返回的 frame 作为 expectFrameHash：画面变了会被拒绝（STALE_FRAME），"
                        + "此时应重新观察而不是重试旧坐标。危险动作（支付/转账/删除等）会返回 dangerId，"
                        + "必须先用 device_confirm 取得用户同意。重试同一动作时务必复用同一个 actionId。")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "deviceId": {"type": "string", "description": "设备标识；只有一台设备时可省略"},
                            "kind": {"type": "string", "enum": ["tap", "long_press", "swipe", "set_text", "back", "home", "recents", "open_app", "notify_list", "key"]},
                            "params": {"type": "object", "description": "参数：tap/long_press 需 point={x,y}；swipe 需 from/to/durationMs；set_text 需 text；open_app 需 packageName；key 需 keyCode"},
                            "expectFrameHash": {"type": "string", "description": "上一次观察返回的 frame 值，必须原样带回"},
                            "actionId": {"type": "string", "description": "幂等键。重试同一动作时必须复用，否则会被当成新动作"},
                            "targetText": {"type": "string", "description": "目标元素的可读文本，用于危险动作判定"}
                          },
                          "required": ["kind"]
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .maxOutput(ACTION_MAX_OUTPUT)
                .timeout(20L)
                .build();
        log.info("注册设备工具: toolName={}", name);
        return definition;
    }

    @Bean
    @ConditionalOnMissingBean(name = "deviceConfirmToolDefinition")
    public ToolDefinition<DeviceConfirmExecutor> deviceConfirmToolDefinition(
            DeviceToolService deviceToolService, ObjectMapper objectMapper) {
        String name = "device_confirm";
        ToolDefinition<DeviceConfirmExecutor> definition = ToolDefinition.<DeviceConfirmExecutor>builder()
                .executor(new DeviceConfirmExecutor(deviceToolService, objectMapper))
                .id(name)
                .name(name)
                .description("对需要人工确认的危险动作给出答复。approved=true 表示用户明确同意执行，"
                        + "false 表示拒绝。绝不能在用户没表态时传 true。")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "dangerId": {"type": "string", "description": "device_action 返回的 dangerId"},
                            "approved": {"type": "boolean", "description": "用户是否同意执行"}
                          },
                          "required": ["dangerId", "approved"]
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.SERIAL)
                .maxOutput(ACTION_MAX_OUTPUT)
                .timeout(10L)
                .build();
        log.info("注册设备工具: toolName={}", name);
        return definition;
    }

    @Bean
    @ConditionalOnMissingBean(name = "deviceStopToolDefinition")
    public ToolDefinition<DeviceStopExecutor> deviceStopToolDefinition(
            DeviceToolService deviceToolService, ObjectMapper objectMapper) {
        String name = "device_stop";
        ToolDefinition<DeviceStopExecutor> definition = ToolDefinition.<DeviceStopExecutor>builder()
                .executor(new DeviceStopExecutor(deviceToolService, objectMapper))
                .id(name)
                .name(name)
                .description("急停：取消设备上所有未执行的动作并清空待确认队列。"
                        + "用户说停、或你发现操作正在产生非预期影响时立即调用。")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "deviceId": {"type": "string", "description": "设备标识；只有一台设备时可省略"}
                          }
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.SERIAL)
                .maxOutput(ACTION_MAX_OUTPUT)
                .timeout(5L)
                .build();
        log.info("注册设备工具: toolName={}", name);
        return definition;
    }
}
