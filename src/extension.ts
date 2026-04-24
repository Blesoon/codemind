import * as vscode from 'vscode';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { CodeMindCompletionProvider } from './providers/InlineCompletionProvider'; 

// 1. 전역 변수로 선언
let myStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    
    // 2. 상태 바 생성 (우측 하단 우선순위 100)
    myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.text = `$(sparkle) CodeMind`;
    myStatusBarItem.show(); // 초기 실행 시 보여주기
    
    context.subscriptions.push(myStatusBarItem);

    // 2. 채팅 뷰 등록
    const chatProvider = new ChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("codemind.chatView", chatProvider)
    );

    // 3. 인라인 자동완성 등록
    const inlineProvider = new CodeMindCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' }, 
            inlineProvider
        )
    );

    console.log('CodeMind 확장 프로그램이 활성화되었습니다.');
}

// 3. 반드시 이 함수가 export 되어야 ChatViewProvider에서 부를 수 있습니다.
export function updateAIStatus(isThinking: boolean) {
    if (!myStatusBarItem) return; // 객체가 없으면 중단

    if (isThinking) {
        myStatusBarItem.text = `$(sync~spin) CodeMind 생각 중...`;
        myStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); // 눈에 띄게 빨간색/주황색 계열
    } else {
        myStatusBarItem.text = `$(sparkle) CodeMind`;
        myStatusBarItem.backgroundColor = undefined;
    }
    myStatusBarItem.show(); // 텍스트 갱신 후 다시 보여주기 확인
}

export function deactivate() {}