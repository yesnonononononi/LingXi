package com.summit.dp.tools.api;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.tools.application.service.ToolService;
import com.summit.dp.tools.application.vo.ToolVO;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
@RequiredArgsConstructor
@RestController
@RequestMapping("/tools")
public class ToolController {
    private final ToolService toolService;

    @GetMapping("/list")
    public Result<List<ToolVO>> list(){
        return  toolService.list();
    }
}
