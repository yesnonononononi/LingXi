package com.summit.dp.tools.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.tools.application.vo.ToolVO;

import java.util.List;

public interface ToolService {
   Result<List<ToolVO>> list();
}
