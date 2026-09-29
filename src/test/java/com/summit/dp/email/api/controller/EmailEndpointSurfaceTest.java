package com.summit.dp.email.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.application.vo.EmailVO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 接口面防回归：写端点必须保持下线，只读查询与受控级联删除必须保持可用。
 *
 * <p>被删掉的四个端点正是本次重设计要堵的口子，光靠 grep 确认「代码里没有」不足以守护——
 * 任何人都可能把它们加回来。这里按<b>原来的 HTTP 方法</b>发请求（避免「方法不匹配」造成的
 * 假 404），断言它们确实不存在。</p>
 */
class EmailEndpointSurfaceTest {

    private final EmailService service = mock(EmailService.class);
    private MockMvc mockMvc;

    @BeforeEach
    void setup() {
        mockMvc = MockMvcBuilders.standaloneSetup(new EmailController(service)).build();
        when(service.findById(anyLong())).thenReturn(Result.success(EmailVO.builder().id(1L).build()));
        when(service.listMessages(anyLong())).thenReturn(Result.success(List.<EmailMessageVO>of()));
        when(service.delById(anyLong())).thenReturn(Result.success());
    }

    @Test
    @DisplayName("写端点已下线：路由字段与发件人身份不再能由外部指定")
    void writeEndpointsAreGone() throws Exception {
        // /email/add、/email/update：曾允许客户端任意指定或修改 agent_id / root_execution_id / target_execution_id
        mockMvc.perform(post("/email/add").contentType(APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());
        mockMvc.perform(post("/email/update").contentType(APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());

        // /email/message/add：曾允许调用方自带 senderId，等于冒充任意 Agent 发信
        mockMvc.perform(post("/email/message/add").contentType(APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());

        // /email/message/consume-pending：曾允许外部按任意业务键把命中消息置为 CONSUMED，等于抽干他人邮箱
        mockMvc.perform(post("/email/message/consume-pending")
                        .param("workflowExecutionId", "900")
                        .param("recipientAgentId", "7"))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("保留端点仍可用：只读查询")
    void readEndpointsRemain() throws Exception {
        mockMvc.perform(get("/email/find/1")).andExpect(status().isOk());
        mockMvc.perform(get("/email/message/list/1")).andExpect(status().isOk());
    }

    @Test
    @DisplayName("级联删除只接受 DELETE：GET 打不出去，避免被预加载/爬虫误触发删库")
    void cascadeDeleteIsNotReachableByGet() throws Exception {
        mockMvc.perform(get("/email/del/1")).andExpect(status().isMethodNotAllowed());
        mockMvc.perform(delete("/email/del/1")).andExpect(status().isOk());
    }
}
