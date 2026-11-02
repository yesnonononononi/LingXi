package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;

import java.net.InetSocketAddress;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

/** 对话模型调用生图工具，配置、配额、落盘、用量与历史必须闭环。 */
@SpringBootTest(properties={"TAVILY_APIKEY=test-placeholder","DEEPSEEK_APIKEY=test-placeholder","lingxi.skill.dir="})
@AutoConfigureMockMvc(print=MockMvcPrint.NONE)
class ImageGenerationFlowTest {
    private static final Path ROOT=createRoot();
    private static final String DATABASE=H2TestDatabase.newDatasourceUrl("image-tool-flow");
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;
    @Autowired private ModelService models;
    @Autowired private SessionService sessions;
    @Autowired private ChatTurnRepository turns;
    @MockitoSpyBean private SseEventPublisher publisher;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",()->DATABASE);
        registry.add("spring.datasource.driver-class-name",()->"org.h2.Driver");
        registry.add("lingxi.data.dir",()->ROOT.resolve("data").toString());
        registry.add("lingxi.skill.dir",()->"");
        for(String setting:List.of("model","provider","user-configs","mcp","personalization"))
            registry.add("lingxi.config."+setting+".path",()->ROOT.resolve(setting+".json").toString());
        registry.add("lingxi.config.sandbox-security.directory",()->ROOT.resolve("security").toString());
    }

    @Test void chatModelGeneratesAFileThroughTheToolAndSettlesItsUsage() throws Exception {
        AtomicInteger chatCalls=new AtomicInteger();
        AtomicInteger imageCalls=new AtomicInteger();
        List<JsonNode> frames=new CopyOnWriteArrayList<>();
        doAnswer(invocation->{frames.add(mapper.valueToTree(invocation.getArgument(2)));return invocation.callRealMethod();})
                .when(publisher).publishBusiness(anyLong(),anyString(),any());
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/v1/images/generations",exchange->{
            imageCalls.incrementAndGet();
            JsonNode request=mapper.readTree(exchange.getRequestBody());
            assertEquals("A red sailboat with a white sail, sunset, detailed illustration",request.path("prompt").asText());
            assertEquals("image-test",request.path("model").asText());
            String png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V0AAAAASUVORK5CYII=";
            byte[] body=mapper.writeValueAsBytes(Map.of("created",1,"data",List.of(Map.of("b64_json",png)),
                    "usage",Map.of("input_tokens",15,"output_tokens",80,"total_tokens",95)));
            exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,body.length);
            try(OutputStream output=exchange.getResponseBody()){output.write(body);}
        });
        server.createContext("/v1/chat/completions",exchange->{
            JsonNode request=mapper.readTree(exchange.getRequestBody());
            int round=chatCalls.incrementAndGet();
            Map<String,Object> message;
            if(round==1) {
                assertTrue(request.path("tools").toString().contains("generate_image"));
                String prompt="A red sailboat with a white sail, sunset, detailed illustration";
                message=Map.of("role","assistant","tool_calls",List.of(
                        Map.of("id","image-1","type","function","function",Map.of("name","generate_image","arguments",mapper.writeValueAsString(Map.of("prompt",prompt,"path","art/boat.png")))),
                        Map.of("id","image-2","type","function","function",Map.of("name","generate_image","arguments",mapper.writeValueAsString(Map.of("prompt",prompt,"path","art/extra.png"))))));
            } else {
                String url=null;int receipts=0;
                for(JsonNode row:request.path("messages"))if("tool".equals(row.path("role").asText())) {
                    receipts++;
                    String text=row.path("content").asText();
                    if("image-1".equals(row.path("tool_call_id").asText()))url=mapper.readTree(text).path("previewUrl").asText();
                    else assertTrue(text.contains("次数上限"),text);
                }
                assertEquals(2,receipts);assertNotNull(url);
                message=Map.of("role","assistant","content","已生成并保存：![红色帆船]("+url+")");
            }
            byte[] body=mapper.writeValueAsBytes(Map.of("id","chat-"+round,"object","chat.completion","model","chat-test",
                    "choices",List.of(Map.of("index",0,"message",message,"finish_reason",round==1?"tool_calls":"stop")),
                    "usage",Map.of("prompt_tokens",10,"completion_tokens",5,"total_tokens",15)));
            exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,body.length);
            try(OutputStream output=exchange.getResponseBody()){output.write(body);}
        });
        server.start();
        try {
            String base="http://127.0.0.1:"+server.getAddress().getPort()+"/v1";
            long image=addModel(base,"image-test","default-image-model");
            long chat=addModel(base,"chat-test","default");
            Path work=Files.createDirectories(ROOT.resolve("workspace"));
            JsonNode configured=postJson("/config/current/update",Map.of("type","LOCAL","commandApprovalPolicy","FULL_ACCESS",
                    "imageModelId",Long.toString(image),"imageGenerationMaxCalls",1));
            assertEquals(1,configured.path("code").asInt(),configured.toString());
            JsonNode settings=mapper.readTree(mvc.perform(get("/config/current")).andReturn().getResponse().getContentAsString()).path("data");
            assertEquals(image,settings.path("imageModelId").asLong());
            assertEquals(1,settings.path("imageGenerationMaxCalls").asInt());
            assertEquals(image,mapper.readTree(ROOT.resolve("user-configs.json").toFile()).get(0).path("imageModelId").asLong());
            long workspace=postJson("/workspace/add",Map.of("name","生图工具验证","hostDir",work.toString())).path("data").asLong();
            Long sessionId=sessions.initialize("生成帆船插画",workspace,null).getData();
            JsonNode accepted=mapper.readTree(mvc.perform(multipart("/a/completion/commands").param("sessionId",sessionId.toString())
                    .param("modelId",Long.toString(chat)).param("input","先完善提示词，再生成一张帆船插画"))
                    .andReturn().getResponse().getContentAsString());
            assertEquals(1,accepted.path("code").asInt(),accepted.toString());
            long turnId=accepted.path("data").path("turnId").asLong();
            await().atMost(Duration.ofSeconds(60)).until(()->turns.findById(turnId).map(turn->turn.getStatus().isTerminal()).orElse(false));
            ChatTurn turn=turns.findById(turnId).orElseThrow();
            assertEquals(ChatTurnStatus.COMPLETED,turn.getStatus(),turn.getErrorReason());
            assertEquals(1,imageCalls.get());assertEquals(2,chatCalls.get());
            assertEquals(125L,turn.getTotalTokenCount());
            assertTrue(Files.isRegularFile(work.resolve("art/boat.png")));
            assertFalse(Files.exists(work.resolve("art/extra.png")));
            JsonNode history=mapper.readTree(mvc.perform(get("/session/{id}/messages",sessionId)).andReturn().getResponse().getContentAsString())
                    .path("data").path("turnViews").path(Long.toString(turnId));
            JsonNode body=null;
            for(JsonNode block:history.path("blocks"))if(block.path("isBody").asBoolean())body=block;
            assertNotNull(body);assertTrue(body.path("text").asText().contains("![红色帆船](/a/images/"));
            String text=body.path("text").asText();String url=text.substring(text.indexOf("(/a/images/")+1,text.lastIndexOf(')'));
            assertArrayEquals(Files.readAllBytes(work.resolve("art/boat.png")),mvc.perform(get(url)).andReturn().getResponse().getContentAsByteArray());
            await().atMost(Duration.ofSeconds(5)).until(()->frames.stream().anyMatch(frame->frame.toString().contains(url)));
        } finally {server.stop(0);}
    }

    private long addModel(String base,String name,String provider) throws Exception {
        JsonNode saved=postJson("/model/add",Map.of("baseUrl",base,"apiKey","local-test-key","modelName",name,"provider",provider,"useProvider",false,"vision",false));
        assertEquals(1,saved.path("code").asInt(),saved.toString());
        return models.catalog().getData().stream().flatMap(group->group.getModels().stream()).filter(model->name.equals(model.getModelName())).findFirst().orElseThrow().getId();
    }
    private JsonNode postJson(String path,Object payload) throws Exception {
        return mapper.readTree(mvc.perform(post(path).contentType("application/json").content(mapper.writeValueAsBytes(payload))).andReturn().getResponse().getContentAsString());
    }
    private static Path createRoot() {
        try{return Files.createTempDirectory("lingxi-image-tool-");}
        catch(Exception error){throw new IllegalStateException(error);}
    }
}
