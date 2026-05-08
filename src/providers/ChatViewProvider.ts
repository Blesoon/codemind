import * as vscode from 'vscode';
import { callOllamaStream, callOllamaStatic, callOpenHandsAgent } from '../utils/ollama';
import { getProjectSummary } from '../utils/workspace';
import * as path from 'path';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _lastSelectedCode: string = "";
    private _chatHistory: ChatMessage[] = []; 
    private readonly _maxHistoryLength = 10;
    private _summaryContext: string = ""; 

    private _abortController: AbortController | null = null; // 중단용 컨트롤러

    // 자율 수정 최대 횟수
    private readonly MAX_REPAIR_ATTEMPTS = 2;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { 
            enableScripts: true, localResourceRoots: [this._extensionUri] 
        };

        const markedJsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'marked.min.js')
        );

        // 코드 선택 감지 listener
        const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
            const selection = event.selections[0];
            this._lastSelectedCode = (selection && !selection.isEmpty) 
                ? event.textEditor.document.getText(selection) : "";
        });
        webviewView.onDidDispose(() => selectionListener.dispose());

        webviewView.webview.html = this._getHtmlContent(markedJsUri);

        // 초기 프로젝트 분석
        (async () => {
            try {
                const projectDetails = await this._getDetailedProjectContext();
                this._summaryContext = `이 프로젝트의 구조: ${projectDetails}`;
                webviewView.webview.postMessage({ command: 'response-chunk', text: "🚀 **CodeMind 준비 완료!**" });
                webviewView.webview.postMessage({ command: 'response-end' });
            } catch (e) { console.error(e); }
        })();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.command === 'ask') {
                // 모든 질문 처리를 통합 함수로 전달 (시도 횟수 0부터 시작)
                await this.handleDirectAsk(data.text.trim(), webviewView, 0);
            }
            else if (data.command === 'stopGeneration') {
                if (this._abortController) {
                    this._abortController.abort();
                    this._abortController = null;
                    webviewView.webview.postMessage({ command: 'response-end' });
                }
            }
            else if (data.command === 'runTerminal') {
                this._executeTerminalCommand(data.code);
            }
            else if (data.command === 'clearHistory') {
                this._chatHistory = [];
                this._summaryContext = "";
            }
            else if (data.command === 'insertCode') {
                const editor = vscode.window.activeTextEditor;
                if (editor) editor.edit(eb => eb.insert(editor.selection.active, data.code));
            }
            else if (data.command === 'createFile') {
                const filePath = await vscode.window.showInputBox({ prompt: "파일 경로 입력", value: "new_file.txt" });
                if (filePath) {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
                        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(data.code, 'utf8'));
                        vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fileUri));
                    }
                }
            }
        });
    }

    /**
     * 질문 처리 및 AI 응답 제어 통합 함수
     */
    private async handleDirectAsk(text: string, webviewView: vscode.WebviewView, attempt: number = 0) {
        this._abortController = new AbortController();

        // 1. 매 질문 시 프로젝트 구조 최신화
        try {
            const freshContext = await this._getDetailedProjectContext();
            this._summaryContext = freshContext;
        } catch (e) { console.error("Context 갱신 실패:", e); }

        let userText = text;
        let systemInstruction = "당신은 실력 있는 소프트웨어 엔지니어입니다. 반드시 한국어로 답변하세요. 자기소개는 생략합니다.";
        let finalPrompt = "";

        // --- [명령어 분기 로직] ---
        if (userText.startsWith('/help')) {
            const helpMessage = `
### 🤖 CodeMind 도움말
사용 가능한 명령어는 다음과 같습니다:
* **/explain**: 선택된 코드의 동작 원리를 설명합니다.
* **/fix**: 버그 분석 및 수정안을 제시합니다.
* **/refactor**: 코드 개선 제안을 합니다.
* **/test**: 유닛 테스트 코드를 생성합니다.
* **/doc**: 문서화를 수행합니다.
* **/list**: 파일 구조를 분석합니다.
* **/agent [내용]**: 에이전트 미션을 수행합니다.
* **/audit [내용]**: 테스트 수행 및 자동 수정을 시도합니다.`;

            webviewView.webview.postMessage({ command: 'response-chunk', text: helpMessage });
            webviewView.webview.postMessage({ command: 'response-end' });
            return;
        }

        if (userText.startsWith('/explain')) {
            systemInstruction += " 선택된 코드를 단계별로 설명하세요.";
            finalPrompt = `[코드 설명 요청]:\n${this._lastSelectedCode}\n\n질문: ${userText}`;
        } 
        else if (userText.startsWith('/fix')) {
            systemInstruction += " 버그를 찾고 수정된 코드와 설명을 제시하세요.";
            finalPrompt = `[버그 수정 요청]:\n${this._lastSelectedCode}\n\n내용: ${userText}`;
        }
        else if (userText.startsWith('/refactor')) {
            systemInstruction += " 가독성과 성능을 개선하고 변경 이유를 설명하세요.";
            finalPrompt = `[리팩토링 요청]:\n${this._lastSelectedCode}`;
        }
        else if (userText.startsWith('/test')) {
            systemInstruction += " 유닛 테스트 코드를 작성하세요.";
            finalPrompt = `[테스트 생성 요청]:\n${this._lastSelectedCode}`;
        }
        else if (userText.startsWith('/doc')) {
            systemInstruction += " JSDoc 또는 주석 문서를 작성하세요.";
            finalPrompt = `[문서화 요청]:\n${this._lastSelectedCode}`;
        }
        else if(userText.startsWith('/list')) {
            const currentStructure = await getProjectSummary();
            systemInstruction = "프로젝트 구조 분석가로서 파일 목록을 트리 형태로 요약하세요.";
            finalPrompt = `[분석할 파일 목록]:\n${currentStructure}`;
        }
        else if (userText.startsWith('/agent')) {
            const currentStructure = await getProjectSummary();
            this._summaryContext = currentStructure; 
            const task = userText.replace('/agent', '').trim();
            systemInstruction = `당신은 Full-stack 개발 에이전트입니다.
반드시 아래 규칙을 지키세요:
1. Nexacro: 'this.ds_list.clearData();' 등 전용 API 사용.
2. Spring Boot: Lombok 사용 여부 확인.
[응답 규칙]
- 파일 경로는 'FILE_PATH: '로 시작.
- 코드는 'FILE_CONTENT: ' 뒤 마크다운 블록으로 작성.
- 마무리는 'FILE_END'.`;
            finalPrompt = `[현재 프로젝트 구조]\n${this._summaryContext}\n\n[수행할 미션]: ${task}\n\n위 구조를 참고해서 파일을 생성해줘.`;
        } 
        else if (userText.startsWith('/audit')) {
            const task = userText.replace('/audit', '').trim();
            const currentStructure = await getProjectSummary();
            systemInstruction = `당신은 QA 에이전트입니다. 테스트 코드를 작성하고, 응답에 반드시 'RUN_COMMAND: [명령어]'를 포함하세요.`;
            finalPrompt = `[구조]\n${currentStructure}\n[미션]: ${task}에 대한 테스트를 수행하고 결함을 찾아줘.`;
        }
        else if (userText.startsWith('[테스트 실패 보고]')) {
            systemInstruction = `당신은 버그 수정 에이전트입니다. 로그를 분석하여 코드를 고치고 다시 테스트할 수 있도록 RUN_COMMAND를 포함하세요.`;
            finalPrompt = userText;
        }
        else {
            const shortContext = this._summaryContext.length > 500 ? this._summaryContext.substring(0, 500) + "..." : this._summaryContext;
            finalPrompt = `[프로젝트 정보 요약]: ${shortContext}\n[선택 코드]: ${this._lastSelectedCode}\n질문: ${userText}`;
        }

        try {
            const historyText = this._chatHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
            let fullContext = `### System: ${systemInstruction}\n\n### Project Context:\n${this._summaryContext}\n\n${historyText}\nUser: ${userText}\nAssistant: `;

            let aiResponse = ""; 
            await callOllamaStream(fullContext, (chunk) => {
                if (this._abortController?.signal.aborted) return;
                aiResponse += chunk;
                webviewView.webview.postMessage({ command: 'response-chunk', text: chunk });
            });
            
            if (!this._abortController?.signal.aborted) {
                this._chatHistory.push({ role: 'assistant', content: aiResponse });
                webviewView.webview.postMessage({ command: 'response-end' });

                // 파일 생성 처리
                if (aiResponse.includes("FILE_PATH:")) {
                    await this._handleAutoFileCreation(aiResponse);
                }

                // Self-Healing 루프 처리
                if (aiResponse.includes("RUN_COMMAND:")) {
                    const cmdMatch = aiResponse.match(/RUN_COMMAND:\s*(.+)/);
                    if (cmdMatch) {
                        const testCmd = cmdMatch[1].trim();
                        await this._runSelfHealingLoop(testCmd, webviewView, attempt);
                    }
                }

                if (this._chatHistory.length > this._maxHistoryLength) await this._handleSummarization();
            }
        } catch (error) {
            console.error("Chat Error:", error);
            webviewView.webview.postMessage({ command: 'response-end' });
        } finally {
            this._abortController = null;
        }
    }

    private async _executeTerminalCommand(command: string) {
        // [보안 패치] 직접 명령어 실행 경고창 추가
        const answer = await vscode.window.showWarningMessage(
            `⚠️ AI가 다음 터미널 명령어를 실행하려고 합니다.\n명령어: ${command}`,
            { modal: true },
            "실행 허용", "거부"
        );

        if (answer !== "실행 허용") {
            vscode.window.showInformationMessage("명령어 실행이 취소되었습니다.");
            return;
        }

        let terminal = vscode.window.activeTerminal;
        if (!terminal) terminal = vscode.window.createTerminal("CodeMind Terminal");
        terminal.show();
        terminal.sendText(command);
    }

    private async _executeTerminalAndGetOutput(command: string): Promise<string> {
        return new Promise(async (resolve) => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return resolve("워크스페이스를 찾을 수 없습니다.");

            // [보안 패치] Audit 루프에서도 무단 실행 방지
            const answer = await vscode.window.showWarningMessage(
                `⚠️ AI 검증 에이전트가 다음 명령어를 백그라운드에서 실행하려고 합니다.\n명령어: ${command}`,
                { modal: true },
                "실행 허용", "거부"
            );

            if (answer !== "실행 허용") {
                return resolve("[에러] 사용자가 명령어 실행을 거부했습니다.");
            }

            const logPath = path.join(workspaceFolders[0].uri.fsPath, 'test_output.log');
            const fullCommand = `${command} > "${logPath}" 2>&1`; 

            let terminal = vscode.window.activeTerminal || vscode.window.createTerminal("CodeMind Runner");
            terminal.show();
            terminal.sendText(fullCommand);

            setTimeout(async () => {
                try {
                    const logUri = vscode.Uri.file(logPath);
                    const logContent = await vscode.workspace.fs.readFile(logUri);
                    resolve(Buffer.from(logContent).toString('utf8'));
                } catch (e) {
                    resolve("결과 로그를 읽을 수 없거나 테스트가 너무 오래 걸렸습니다.");
                }
            }, 5000); 
        });
    }

    private async _getDetailedProjectContext() {
        const summary = await getProjectSummary();
        const hierarchyGuide = `
[프레임워크 연동 규칙]
- 경로: 루트 기준 상대 경로 엄격 준수.`;

        const coreFiles = await vscode.workspace.findFiles(
            '{package.json,build.gradle,src/**/api/*.js,src/**/controller/*Controller.java,**/*.xjs}', 
            '**/node_modules/**', 10
        );
        
        let coreContent = "";
        for (const file of coreFiles) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                const relPath = vscode.workspace.asRelativePath(file);
                // 파일 컨텍스트 추출량 조정
                coreContent += `\n[FILE: ${relPath}]\n${doc.getText().substring(0, 800)}...\n`;
            } catch (e) {
                console.warn("파일을 읽는 중 오류 발생:", file.fsPath);
            }
        }
        
        return `${hierarchyGuide}\n\n[프로젝트 구조]\n${summary}\n\n[핵심 코드 참고]\n${coreContent}`;
    }

    private async _runSelfHealingLoop(testCommand: string, webviewView: vscode.WebviewView, attempt: number) {
        if (attempt >= this.MAX_REPAIR_ATTEMPTS) {
            webviewView.webview.postMessage({ 
                command: 'response-chunk', 
                text: `\n\n⚠️ **자율 수정 중단**: ${this.MAX_REPAIR_ATTEMPTS}회 시도했으나 결함이 지속됩니다.` 
            });
            webviewView.webview.postMessage({ command: 'response-end' });
            return;
        }

        webviewView.webview.postMessage({ 
            command: 'response-chunk', 
            text: `\n\n--- \n🔍 **[자동 검증 ${attempt + 1}회차]** 테스트 실행 중...` 
        });

        const testLog = await this._executeTerminalAndGetOutput(testCommand);
        const isFailed = /fail|error|exception|invalid/i.test(testLog);

        if (isFailed) {
            const optimizedLog = testLog.length > 1000 ? `...로그 생략...\n${testLog.substring(testLog.length - 1000)}` : testLog;
            webviewView.webview.postMessage({ 
                command: 'response-chunk', 
                text: `\n\n❌ **결함 발견!** 에러 로그 분석 중...\n\n\`\`\`text\n${optimizedLog.substring(0, 300)}...\n\`\`\`` 
            });

            const repairPrompt = `
    [테스트 실패 보고]
    - 시도 횟수: ${attempt + 1}/${this.MAX_REPAIR_ATTEMPTS}
    - 에러 로그 요약: ${optimizedLog}
    위 에러를 분석하여 결함을 고쳐주세요. FILE_PATH, FILE_CONTENT, FILE_END 형식을 준수하고 RUN_COMMAND도 포함하세요.`;
            
            await this.handleDirectAsk(repairPrompt, webviewView, attempt + 1); 

        } else {
            webviewView.webview.postMessage({ 
                command: 'response-chunk', 
                text: "\n\n✅ **검증 완료!** 테스트를 통과했거나 실행 거부되었습니다." 
            });
            webviewView.webview.postMessage({ command: 'response-end' });
        }
    }

    private async _handleSummarization() {
        const toSummarize = this._chatHistory.slice(0, 4);
        const summaryPrompt = `### Instruction:\n다음 대화를 핵심 개발 맥락 위주로 요약해줘:\n${toSummarize.map(m => m.content).join('\n')}\n\n### Response:\n`;
        try {
            const summary = await callOllamaStatic(summaryPrompt);
            if (summary) {
                this._summaryContext = this._summaryContext ? `${this._summaryContext} 또한 ${summary}` : summary;
                this._chatHistory.splice(0, 4);
            }
        } catch (e) { console.error("요약 실패", e); }
    }

    private async _handleAutoFileCreation(response: string) {
        const fileBlocks = response.matchAll(/FILE_PATH:\s*(.+?)\s*FILE_CONTENT:\s*([\s\S]+?)\s*FILE_END/gi);

        for (const match of fileBlocks) {
            const filePath = match[1].trim().replace(/`/g, '');
            let newContent = match[2].trim();
            newContent = newContent.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) continue;

            const rootUri = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(rootUri, filePath.replace(/^[\\\/]+/, ''));

            try {
                let fileExists = true;
                try { await vscode.workspace.fs.stat(fileUri); } catch { fileExists = false; }

                if (fileExists) {
                    // [UX 패치] 기존 파일이 있을 경우 Diff 보기 기능 제공
                    const answer = await vscode.window.showInformationMessage(
                        `AI가 [${filePath}] 파일을 수정하려고 합니다.`,
                        "Diff 보기", "바로 덮어쓰기", "건너뛰기"
                    );

                    if (answer === "Diff 보기") {
                        const tempUri = vscode.Uri.joinPath(rootUri, `${filePath}.codemind.temp`);
                        await vscode.workspace.fs.writeFile(tempUri, Buffer.from(newContent, 'utf8'));
                        
                        // VS Code 내장 Diff 에디터 호출
                        await vscode.commands.executeCommand('vscode.diff', fileUri, tempUri, `[AI 제안] ${path.basename(filePath)}`);
                        vscode.window.showInformationMessage(`변경사항을 확인하고 수동으로 적용하거나 임시 파일을 저장하세요.`);
                    } else if (answer === "바로 덮어쓰기") {
                        await this._saveAgentFile(filePath, newContent);
                    }
                } else {
                    // 새 파일 생성 시
                    const answer = await vscode.window.showInformationMessage(
                        `AI가 새 파일 [${filePath}]을(를) 생성하려고 합니다.`,
                        "생성 허용", "건너뛰기"
                    );
                    if (answer === "생성 허용") {
                        await this._saveAgentFile(filePath, newContent);
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`${filePath} 처리 중 오류: ${err.message}`);
            }
        }
    }

    private async _saveAgentFile(filePath: string, content: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        try {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const absolutePath = path.join(rootPath, filePath.replace(/^[\\\/]+/, ''));
            const fileUri = vscode.Uri.file(absolutePath);
            const directoryPath = path.dirname(absolutePath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(directoryPath));
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`반영 완료: ${filePath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`저장 실패: ${err.message}`);
        }
    }

    private _getHtmlContent(markedJsUri: vscode.Uri): string {
        // [UX 패치] 하드코딩된 색상 제거 및 VS Code 테마 변수 (var(--vscode-...)) 적극 활용
        return `
        <!DOCTYPE html>
        <html>
            <head>
                <meta charset="UTF-8">
                <script src="${markedJsUri}"></script>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css">
                <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
                <style>
                    body { 
                        font-family: var(--vscode-font-family), -apple-system, sans-serif; 
                        color: var(--vscode-editor-foreground); 
                        background-color: var(--vscode-editor-background); 
                        padding: 10px; margin: 0; overflow-x: hidden; 
                    }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; margin-bottom: 10px; position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 10; }
                    .clear-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                    .clear-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    #chat { min-height: 300px; padding-bottom: 10px; }
                    #loading { display: none; flex-direction: column; gap: 8px; padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
                    .progress-container { width: 100%; height: 4px; background-color: var(--vscode-editorWidget-background); border-radius: 2px; overflow: hidden; }
                    .progress-bar { width: 0%; height: 100%; background: linear-gradient(90deg, var(--vscode-progressBar-background), #4fc1ff); transition: width 0.3s ease; }
                    .spinner { width: 14px; height: 14px; border: 2px solid var(--vscode-editorWidget-border); border-top: 2px solid var(--vscode-progressBar-background); border-radius: 50%; animation: spin 1s linear infinite; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    pre { background-color: var(--vscode-textCodeBlock-background); padding: 0; border-radius: 6px; position: relative; border: 1px solid var(--vscode-panel-border); overflow-x: auto; margin: 10px 0; }
                    code { font-family: var(--vscode-editor-font-family), 'Consolas', monospace; font-size: 13px; }
                    .hljs { background: transparent !important; padding: 12px !important; padding-top: 35px !important; }
                    .btn-group { display: flex; gap: 5px; position: absolute; top: 5px; right: 5px; z-index: 20; }
                    .action-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 11px; opacity: 0.9; }
                    .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .run-btn { background: var(--vscode-statusBarItem-warningBackground, #cd7f32); color: white; } 
                    .user-msg { color: var(--vscode-textLink-foreground); margin-top: 15px; font-weight: bold; border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 8px; font-size: 13px; }
                    .ai-msg { background: var(--vscode-editorWidget-background); padding: 12px; border-radius: 8px; margin-top: 5px; border: 1px solid var(--vscode-panel-border); line-height: 1.6; font-size: 13px; word-wrap: break-word; }
                    .input-container { position: sticky; bottom: 0; background: var(--vscode-editor-background); padding: 10px 0; border-top: 1px solid var(--vscode-panel-border); }
                    textarea { width: 100%; height: 70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px; border-radius: 4px; resize: none; outline: none; box-sizing: border-box; }
                    textarea:focus { border-color: var(--vscode-focusBorder); }
                    #sendBtn { width: 100%; height: 35px; margin-top: 5px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
                    #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
                </style>
            </head>
            <body>
                <div class="header"><strong>CodeMind AI</strong><button class="clear-btn" onclick="clearChat()">Clear</button></div>
                <div id="chat"></div>
                <div id="loading"><div class="loading-top"><div class="spinner"></div><span>AI가 생각 중...</span></div><div class="progress-container"><div id="progressBar" class="progress-bar"></div></div></div>
                <div class="input-container"><textarea id="input" placeholder="명령어를 입력하세요..."></textarea><button id="sendBtn" onclick="send()">전송</button></div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const chatDiv = document.getElementById('chat');
                    const inputField = document.getElementById('input');
                    const sendBtn = document.getElementById('sendBtn');
                    const loadingDiv = document.getElementById('loading');
                    const progressBar = document.getElementById('progressBar');
                    let currentFullText = "";
                    let progressInterval;

                    marked.setOptions({
                        highlight: function (code, lang) {
                            const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                            return hljs.highlight(code, { language }).value;
                        }
                    });
                    
                    window.addEventListener('message', event => {
                        const m = event.data;
                        if (m.command === 'response-chunk') {
                            currentFullText += m.text;
                            let lastAi = document.querySelector('.ai-msg:last-child');
                            if (!lastAi || lastAi.dataset.complete === "true") {
                                lastAi = document.createElement('div');
                                lastAi.className = 'ai-msg';
                                chatDiv.appendChild(lastAi);
                            }
                            lastAi.innerHTML = "<b>AI:</b><br>" + marked.parse(currentFullText);
                            lastAi.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
                            window.scrollTo(0, document.body.scrollHeight);
                        } 
                        if (m.command === 'response-end') {
                            clearInterval(progressInterval);
                            progressBar.style.width = '100%';
                            setTimeout(() => { loadingDiv.style.display = 'none'; progressBar.style.width = '0%'; }, 500);
                            resetSendBtn(); 
                            const lastAi = document.querySelector('.ai-msg:last-child');
                            if(lastAi) {
                                lastAi.dataset.complete = "true";
                                lastAi.querySelectorAll('pre').forEach(block => {
                                    if (block.querySelector('.btn-group')) return;
                                    const group = document.createElement('div'); group.className = 'btn-group';
                                    const code = block.querySelector('code').innerText;
                                    const runBtn = document.createElement('button'); runBtn.className = 'action-btn run-btn'; runBtn.innerText = 'RUN';
                                    runBtn.onclick = () => vscode.postMessage({ command: 'runTerminal', code: code });
                                    const insBtn = document.createElement('button'); insBtn.className = 'action-btn'; insBtn.innerText = 'CREATE';
                                    insBtn.onclick = () => vscode.postMessage({ command: 'createFile', code: code });
                                    const copyBtn = document.createElement('button'); copyBtn.className = 'action-btn'; copyBtn.innerText = 'INSERT';
                                    copyBtn.onclick = () => vscode.postMessage({ command: 'insertCode', code: code });
                                    group.appendChild(runBtn); group.appendChild(insBtn); group.appendChild(copyBtn);
                                    block.appendChild(group);
                                });
                            }
                            currentFullText = "";
                        }
                    });

                    function send() {
                        const text = inputField.value.trim();
                        if(!text) return;
                        chatDiv.innerHTML += '<div class="user-msg">나: ' + text + '</div>';
                        loadingDiv.style.display = 'flex';
                        sendBtn.innerText = "중단 (Stop)"; sendBtn.style.backgroundColor = "var(--vscode-errorForeground)"; sendBtn.onclick = stop;
                        let width = 0; progressInterval = setInterval(() => { width += (95 - width) * 0.1; progressBar.style.width = width + '%'; }, 300);
                        vscode.postMessage({ command: 'ask', text: text });
                        inputField.value = ''; window.scrollTo(0, document.body.scrollHeight);
                    }
                    function stop() { vscode.postMessage({ command: 'stopGeneration' }); resetSendBtn(); }
                    function resetSendBtn() { sendBtn.innerText = "전송"; sendBtn.style.backgroundColor = "var(--vscode-button-background)"; sendBtn.onclick = send; }
                    function clearChat() { chatDiv.innerHTML = ''; vscode.postMessage({ command: 'clearHistory' }); }
                    inputField.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
                </script>
            </body>
        </html>`;
    }
}