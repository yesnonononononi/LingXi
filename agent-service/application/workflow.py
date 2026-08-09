# step1
import dataclasses

from langgraph.constants import START, END
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph

from application.nodes.AgentNode import agentService
from application.nodes.BaseToolNode import baseToolNode
from infrastructure.configuration.GraphDrawer import draw
from infrastructure.entity.state import State
from infrastructure.route.route import tool_route


@dataclasses.dataclass
class WorkFlowBuilder:
    graph_builder:StateGraph
    graph:CompiledStateGraph[State]
    def __init__(self):
        self.graph_builder = StateGraph(State)
        self.graph = None
    @staticmethod
    def build():
        return WorkFlowBuilder()._buildNodeAndEdge()._buildConditionalEdges()

    def _buildNodeAndEdge(self):
        (
            self.graph_builder
        .add_node("agent",agentService.chat)
        .add_node("attempt_tools", baseToolNode)
        .add_edge(START, "agent")
        .add_edge("attempt_tools", "agent")
         )
        return self


    def _buildConditionalEdges(self):
        self.graph_builder.add_conditional_edges("agent", tool_route,{"attempt_tools":"attempt_tools",END:END})
        return self

    def compile(self):
        if self.graph is not None:
            return None
        self.graph =  self.graph_builder.compile()
        return self

    def draw(self):
        if   self.graph is None:
            raise Exception("请先编译流程图")
        draw(self.graph)
if __name__ == '__main__':
    WorkFlowBuilder.build().compile().draw()