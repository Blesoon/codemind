import * as vscode from 'vscode';

export async function getProjectSummary() {
    // 1. 현재 열려있는 워크스페이스 폴더들을 가져옵니다.
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        return "현재 워크스페이스에 열린 폴더가 없습니다. 폴더를 먼저 열어주세요.";
    }
 
    // 2. 현재 창의 첫 번째 폴더를 기준으로 상대 경로 패턴 생성
    const rootFolder = folders[0];
    
    // 💡 최적화 1: 무거운 폴더(.git, dist, coverage 등) 명시적 제외 처리
    const excludePattern = new vscode.RelativePattern(
        rootFolder,
        '{**/node_modules/**,**/build/**,**/out/**,**/.gradle/**,**/.settings/**,**/target/**,**/.vscode/**,**/.metadata/**,**/.git/**,**/dist/**,**/coverage/**}'
    );

    // 💡 최적화 2: AI가 구조 파악에 필요한 핵심 확장자만 필터링 (RelativePattern 사용)
    const includePattern = new vscode.RelativePattern(
        rootFolder, 
        '**/*.{java,vue,js,ts,xml,gradle,py,go,cpp,c,h,cs,php,html,css,json,md,toml}'
    );
    
    try {
        // 💡 최적화 3: '**/*' 대신 정의해둔 includePattern을 사용하여 검색 속도 비약적 상승
        // AI가 너무 적은 파일을 보면 컨텍스트가 부족하므로 제한을 30 -> 50 정도로 약간 늘렸습니다. (필요시 조절)
        const files = await vscode.workspace.findFiles(includePattern, excludePattern, 50);
        
        if (files.length === 0) {
            return `[${rootFolder.name}] 폴더 내에 분석할 수 있는 주요 파일이 없습니다.`;
        }

        let summary = `현재 활성화된 프로젝트: ${rootFolder.name}\n파일 목록:\n`;
        
        // 💡 최적화 4: 문자열 더하기 연산 최적화 (map, join 사용)
        summary += files.map(file => `- ${vscode.workspace.asRelativePath(file, false)}`).join('\n');

        return summary;
    } catch (error) {
        return `파일 구조를 읽는 중 오류 발생: ${error}`;
    }
}