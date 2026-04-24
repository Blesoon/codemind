import * as vscode from 'vscode';
import { callOllamaFIM } from '../utils/ollama';

export class CodeMindCompletionProvider implements vscode.InlineCompletionItemProvider {
    private _lastResult: string = ""; 
    private _isFetching: boolean = false;

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[] | undefined> {
        
        // 1. AI 결과가 준비되었다면 즉시 반환
        if (this._lastResult) {
            const result = this._lastResult;
            this._lastResult = ""; 
            this._isFetching = false;

            return [new vscode.InlineCompletionItem(result, new vscode.Range(position, position))];
        }

        // 2. 단축키 호출 시 '분석 중' 표시 및 AI 호출
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke && !this._isFetching) {
            this._isFetching = true;

            const prefix = document.getText(new vscode.Range(Math.max(0, position.line - 10), 0, position.line, position.character));
            const suffix = document.getText(new vscode.Range(position.line, position.character, Math.min(document.lineCount - 1, position.line + 10), 0));

            this.fetchAndReplace(prefix, suffix);

            // '분석 중' 텍스트 반환
            return [new vscode.InlineCompletionItem(" // ... CodeMind 분석 중", new vscode.Range(position, position))];
        }

        return undefined;
    }

    private async fetchAndReplace(prefix: string, suffix: string) {
        try {
            const controller = new AbortController();
            const res = await callOllamaFIM(prefix, suffix, controller.signal);
            
            if (res && res.trim()) {
                this._lastResult = res;
                
                // [핵심] 기존의 '분석 중' 제안을 강제로 닫고 새로 호출
                // 1. 현재 떠 있는 인라인 제안(분석 중)을 숨깁니다.
                await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
                
                // 2. 아주 짧은 찰나의 대기 (VS Code 엔진이 정리될 시간)
                setTimeout(() => {
                    // 3. 다시 제안을 트리거하면 _lastResult가 화면에 꽂힙니다.
                    vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                }, 30);
            } else {
                this._isFetching = false;
                await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
            }
        } catch (e) {
            this._isFetching = false;
            await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
        }
    }



    private async getOllamaCompletionQwen(prefix: string, suffix: string, token: vscode.CancellationToken): Promise<string> {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        try {
            return await callOllamaFIM(prefix, suffix, abortController.signal);
        } catch (err) {
            return "";
        }
    }
}