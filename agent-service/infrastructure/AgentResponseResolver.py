from typing import AsyncIterator

from langchain_core.messages import AIMessage


class AgentResponseResolver:
    def __init__(self):
        pass


    @staticmethod
    def resolve(response:AsyncIterator):
        return response
