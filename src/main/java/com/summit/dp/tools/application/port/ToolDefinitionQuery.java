package com.summit.dp.tools.application.port;

import com.summit.dp.tools.application.vo.ToolVO;
import java.util.List;

/** 工具管理只消费目录投影，框架注册表由接入层读取。 */
public interface ToolDefinitionQuery {
    List<ToolVO> list();
}
