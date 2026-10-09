package com.summit.dp.shared.utils;

import com.summit.core.agent.Image;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.session.domain.model.SessionMessage;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ChatImageResolverTest {
    private final ChatImageResolver resolver = new ChatImageResolver();

    @Test
    void uploadsKeepEveryImageAndMimeTypeWithoutRequiringUrls() {
        List<Image> images = resolver.resolve(List.of(file("first.png", "image/png", "png"), file("second.jpg", "image/jpeg", "jpeg")), null);
        assertEquals(2, images.size());
        assertEquals("cG5n", images.get(0).getBase64Data());
        assertEquals("image/png", images.get(0).mimeType());
        assertEquals("anBlZw==", images.get(1).getBase64Data());
        assertEquals("image/jpeg", images.get(1).mimeType());
    }

    @Test
    void urlOnlyInputsKeepRemoteAndDataUrlImagesInOrder() {
        List<Image> images = resolver.resolve(null, List.of("https://example.com/first.png", "data:image/jpeg;base64,anBlZw=="));
        assertEquals(2, images.size());
        assertEquals("https://example.com/first.png", images.get(0).getUrl().toString());
        assertEquals("anBlZw==", images.get(1).getBase64Data());
        assertEquals("image/jpeg", images.get(1).mimeType());
    }

    @Test
    void uploadWinsAtItsPositionAndUnequalListsPreserveRemainingUrls() {
        List<MultipartFile> files = Arrays.asList(file("first.png", "image/png", "png"), null);
        List<Image> images = resolver.resolve(files, List.of("https://example.com/ignored.png", "https://example.com/second.png", "https://example.com/third.png"));
        assertEquals(3, images.size());
        assertEquals("cG5n", images.get(0).getBase64Data());
        assertEquals("https://example.com/second.png", images.get(1).getUrl().toString());
        assertEquals("https://example.com/third.png", images.get(2).getUrl().toString());
    }

    @Test
    void textOnlyCommandsAndEmptyInputsRemainCompatible() {
        assertEquals(List.of(), resolver.resolve(null, null));
        assertEquals(List.of(), resolver.resolve(List.of(file("empty.png", "image/png", "")), List.of(" ")));
    }

    @Test
    void requestPreparerBuildsOneUserMessageContainingAllImages() {
        RequestPreparer preparer = new RequestPreparer(null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, resolver);
        ChatCommand command = new ChatCommand("比较两张图片", null, null, null, null, null, false,
                List.of(file("first.png", "image/png", "png"), file("second.jpg", "image/jpeg", "jpeg")), null);
        UserMessageEntity message = preparer.buildUserMessage(command);
        assertEquals(3, message.getContent().size());
        assertEquals("比较两张图片", message.text());
    }

    @Test
    void rejectsNonImagesAndInvalidDataUrlsWithBusinessMessages() {
        assertEquals("只支持上传图片文件", assertThrows(ClientException.class, () -> resolver.resolve(List.of(file("file.txt", "text/plain", "text")), null)).getMessage());
        assertThrows(ClientException.class, () -> resolver.resolve(null, List.of("data:image/png;base64,")));
        assertThrows(ClientException.class, () -> resolver.resolve(null, List.of("data:text/plain;base64,eA==")));
    }

    @Test
    void acceptsTheDomainLimitForUploadsAndAddresses() {
        List<MultipartFile> files = IntStream.range(0, SessionMessage.MAX_IMAGE_COUNT)
                .mapToObj(index -> file("image" + index + ".png", "image/png", "png")).toList();
        List<String> urls = IntStream.range(0, SessionMessage.MAX_IMAGE_COUNT)
                .mapToObj(index -> "https://example.com/" + index + ".png").toList();
        assertEquals(SessionMessage.MAX_IMAGE_COUNT, assertDoesNotThrow(() -> resolver.resolve(files, null)).size());
        assertEquals(SessionMessage.MAX_IMAGE_COUNT, assertDoesNotThrow(() -> resolver.resolve(null, urls)).size());
        assertEquals(SessionMessage.MAX_IMAGE_COUNT, assertDoesNotThrow(() -> resolver.resolve(files, urls)).size());
    }

    @Test
    void rejectsExcessImagesBeforeReadingFilesOrPreparingExecution() throws Exception {
        MultipartFile upload = mock(MultipartFile.class);
        when(upload.isEmpty()).thenReturn(false);
        List<MultipartFile> files = IntStream.rangeClosed(0, SessionMessage.MAX_IMAGE_COUNT)
                .mapToObj(index -> upload).toList();
        RequestPreparer preparer = new RequestPreparer(null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, resolver);
        ChatCommand command = new ChatCommand("分析图片", 42L, null, null, null, null, false, files, null);
        String expected = "每条消息最多上传 " + SessionMessage.MAX_IMAGE_COUNT + " 张图片";
        assertEquals(expected, assertThrows(ClientException.class, () -> preparer.prepare(command)).getMessage());
        verify(upload, never()).getBytes();
        verify(upload, never()).getContentType();
        List<String> urls = IntStream.rangeClosed(0, SessionMessage.MAX_IMAGE_COUNT)
                .mapToObj(index -> "https://example.com/" + index + ".png").toList();
        assertEquals(expected, assertThrows(ClientException.class, () -> resolver.resolve(null, urls)).getMessage());
    }

    private MultipartFile file(String name, String mimeType, String content) {
        return new MockMultipartFile("image", name, mimeType, content.getBytes(StandardCharsets.UTF_8));
    }
}
