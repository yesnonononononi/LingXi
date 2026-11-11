package com.summit.dp.instruction.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;
import com.summit.dp.instruction.application.service.InstructionService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/instruction")
public class InstructionController {

    private final InstructionService instructionService;

    /** 指定轮次的下一句指令预测。 */
    @GetMapping("/next")
    public Result<InstructionVO> next(@RequestParam("sessionId") Long sessionId,
                                      @RequestParam("turnId") Long turnId) {
        return instructionService.next(sessionId, turnId);
    }

    @GetMapping("/{id}")
    public Result<InstructionVO> queryById(@PathVariable("id") Long instructionId) {
        return instructionService.queryById(instructionId);
    }
}
