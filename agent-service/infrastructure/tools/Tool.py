from infrastructure.tools.websearch import web_search


class Tools:

    def getTools(self) -> list:
        return [web_search]


tools = Tools()