package com.summit.dp.shared;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.w3c.dom.Document;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathFactory;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

class InitSqlResourceTest {

    @Test
    void ideResourceImportIncludesOnlyRootInitSql() throws Exception {
        Document document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(Path.of("pom.xml").toFile());
        XPath xpath = XPathFactory.newInstance().newXPath();

        // IDE 只导入标准资源声明，额外插件任务不能保证源码启动时存在建表脚本。
        assertEquals("1", xpath.evaluate("count(/project/build/resources/resource"
                + "[directory='${project.basedir}'][includes/include='init.sql'])", document));
        assertEquals("1", xpath.evaluate("count(/project/build/resources/resource"
                + "[directory='${project.basedir}']/includes/include)", document));
        assertEquals("1", xpath.evaluate("count(/project/build/resources/resource"
                + "[directory='src/main/resources'])", document));
    }

    @Test
    void runtimeInitSqlMatchesAuthoritativeRootScript() throws Exception {
        assertArrayEquals(Files.readAllBytes(Path.of("init.sql")),
                new ClassPathResource("init.sql").getContentAsByteArray());
    }
}
