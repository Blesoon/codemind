import * as vscode from 'vscode';

export async function getProjectSummary() {
    // 1. 현재 열려있는 워크스페이스 폴더들을 가져옵니다.
    // F5로 뜬 창에서 이 코드가 실행되면, 그 창에 열린 폴더들이 잡혀야 합니다.
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        return "현재 워크스페이스에 열린 폴더가 없습니다. 폴더를 먼저 열어주세요.";
    }
 
    // 2. 현재 창의 첫 번째 폴더를 기준으로 상대 경로 패턴 생성
    const rootFolder = folders[0];
    
    // 수정된 패턴 (불필요한 경로 대거 추가)
    const excludePattern = '{**/node_modules/**,**/build/**,**/out/**,**/.gradle/**,**/.settings/**,**/target/**,**/.vscode/**,**/.metadata/**}';

    // 💡 핵심: RelativePattern을 사용하여 현재 창의 루트 폴더 내부만 검색하도록 한정
    const pattern = new vscode.RelativePattern(rootFolder, '**/*.{java,vue,js,ts,xml,gradle}');
    
    try {
        

        const files = await vscode.workspace.findFiles('**/*', excludePattern, 30);
        
        if (files.length === 0) {
            return `[${rootFolder.name}] 폴더 내에 분석할 수 있는 주요 파일이 없습니다.`;
        }

        let summary = `현재 활성화된 프로젝트: ${rootFolder.name}\n파일 목록:\n`;
        
        // 3. 파일 목록을 추출할 때도 반드시 workspace.asRelativePath를 사용하여 
        // 현재 열린 창 기준의 상대 경로를 얻습니다.
        files.forEach(file => {
            const relPath = vscode.workspace.asRelativePath(file, false);
            summary += `- ${relPath}\n`;
        });

        return summary;
    } catch (error) {
        return `파일 구조를 읽는 중 오류 발생: ${error}`;
    }
}