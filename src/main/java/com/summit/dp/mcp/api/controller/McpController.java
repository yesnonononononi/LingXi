package com.summit.dp.mcp.api.controller;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.mcp.api.request.McpRequest;
import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.mcp.application.vo.McpConnectionStateVO;
import com.summit.dp.mcp.application.vo.McpConnectionVO;
import com.summit.dp.mcp.application.vo.McpVO;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Mcp 接口层。
 * <p>端点风格与 {@code TeamController} 一致；前端 {@code McpAPI} 按此路径对接。</p>
 */
@RestController
@RequestMapping("/mcp")
@RequiredArgsConstructor
public class McpController {
    private final McpService service;

    @GetMapping("/find/{id}")
    public Result<McpVO> findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @GetMapping("/list")
    public Result<PageResult<McpVO>> listPage(
            @RequestParam(defaultValue = "1") Integer page,
            @RequestParam(defaultValue = "10") Integer pageSize) {
        return service.findPage(page, pageSize);
    }

    @PostMapping("/add")
    public Result<Void> add(@RequestBody McpRequest request) {
        return service.add(toCommand(request));
    }

    @PostMapping("/connect")
    public Result<McpConnectionVO> connect(@RequestBody McpRequest request) {
        return service.connect(toCommand(request));
    }

    @PostMapping("/update")
    public Result<Void> update(@RequestBody McpRequest request) {
        return service.update(toCommand(request));
    }

    @GetMapping("/del/{id}")
    public Result<Void> delById(@PathVariable Long id) {
        return service.delById(id);
    }

    @PostMapping("/reconnect/{id}")
    public Result<McpConnectionStateVO> reconnect(@PathVariable Long id) {
        return service.reconnect(id);
    }

    @GetMapping("/status")
    public Result<List<McpConnectionStateVO>> listStates(@RequestParam(required = false) List<Long> ids) {
        return service.listStates(ids);
    }

    private McpCommand toCommand(McpRequest request) {
        McpCommand command = new McpCommand();
        BeanUtils.copyProperties(request, command);
        return command;
    }
}
