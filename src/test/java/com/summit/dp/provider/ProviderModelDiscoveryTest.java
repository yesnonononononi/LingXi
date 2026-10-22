package com.summit.dp.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.summit.dp.provider.application.service.ProviderModelDiscoveryService;
import com.summit.dp.provider.application.vo.RemoteModelVO;
import com.summit.dp.provider.domain.model.ProviderConfig;
import com.summit.dp.provider.domain.repo.ProviderConfigRepository;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ProviderModelDiscoveryTest {
    @Test
    void serverUsesSavedSecretAndNormalizesTheWireList() throws Exception {
        AtomicReference<String> authorization = new AtomicReference<>();
        HttpServer remote = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        remote.createContext("/v1/models", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            byte[] body = "{\"data\":[{\"id\":\"z-model\"},{\"id\":\"a-model\"},{\"id\":\"z-model\"},{\"id\":2}]}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        remote.start();
        try {
            ProviderConfigRepository repository = mock(ProviderConfigRepository.class);
            String url = "http://127.0.0.1:" + remote.getAddress().getPort() + "/v1/";
            when(repository.findById(7L)).thenReturn(Optional.of(new ProviderConfig(7L, "本地测试", null, url, "saved-secret", 0)));
            ProviderModelDiscoveryService service = new ProviderModelDiscoveryService(repository, new ObjectMapper());
            assertEquals(List.of(new RemoteModelVO("a-model"), new RemoteModelVO("z-model")), service.discover(7L, null, ""));
            assertEquals("Bearer saved-secret", authorization.get());
            service.discover(7L, url, "replacement-secret");
            assertEquals("Bearer replacement-secret", authorization.get());
            assertThrows(ClientException.class, () -> service.discover(null, "file:///secret", "key"));
        } finally {
            remote.stop(0);
        }
    }

    @Test
    void failuresDoNotExposeRemoteBodyOrPretendToHaveModels() throws Exception {
        HttpServer remote = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        remote.createContext("/models", exchange -> {
            byte[] body = "secret echoed by upstream".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(401, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        remote.createContext("/invalid/models", exchange -> {
            byte[] body = "{\"models\":[]}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        remote.start();
        try {
            ProviderModelDiscoveryService service = new ProviderModelDiscoveryService(mock(ProviderConfigRepository.class), new ObjectMapper());
            String base = "http://127.0.0.1:" + remote.getAddress().getPort();
            ClientException failure = assertThrows(ClientException.class, () -> service.discover(null, base, "key"));
            assertTrue(failure.getMessage().contains("401"));
            assertFalse(failure.getMessage().contains("secret"));
            assertThrows(ClientException.class, () -> service.discover(null, base + "/invalid", "key"));
        } finally {
            remote.stop(0);
        }
    }
}
