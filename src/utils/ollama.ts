import axios from 'axios';

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'gemma4';
// OpenHands 전용 서버 주소 (기본값 3000)
const OPENHANDS_URL = 'http://localhost:3000/api/run';

export const callOllamaStream = async (prompt: string, onChunk: (text: string) => void) => {
    const response = await axios.post(OLLAMA_URL, {
        model: MODEL,
        prompt: prompt,
        stream: true
    }, { responseType: 'stream' });

    response.data.on('data', (chunk: Buffer) => {
        const jsonLines = chunk.toString().split('\n');
        for (const line of jsonLines) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.response) onChunk(parsed.response);
            } catch (e) {
                console.error("JSON 파싱 에러:", e);
            }
        }
    });

    return new Promise((resolve) => response.data.on('end', resolve));
};

export const callOllamaStatic = async (prompt: string): Promise<string> => {
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL,
            prompt: prompt,
            stream: false
        });
        return response.data.response;
    } catch (error) {
        console.error("Ollama Static 호출 실패:", error);
        return "";
    }
};

export async function callOllamaFIM(prefix: string, suffix: string, signal: AbortSignal): Promise<string> {
    /**
     * Qwen2.5-Coder의 FIM 성능을 극대화하기 위해 
     * 토큰 사이의 공백을 완전히 제거하고 순수 토큰 구조를 유지합니다.
     */
    const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    
    try {
        const response = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'qwen2.5-coder:1.5b', 
                prompt: prompt,
                stream: false,
                raw: true, // Ollama의 기본 템플릿을 무시하고 프롬프트 그대로 전달
                options: {
                    num_predict: 24,       // 생성할 토큰 수를 확 줄입니다. (64 -> 24) 짧게 자주 보는 게 유리합니다.
                    num_thread: 4,         // PC의 물리 코어 수에 맞추세요. (보통 4 또는 8)
                    num_ctx: 1024,         // 문맥 길이를 줄여서 메모리 점유와 연산량을 낮춥니다. (기본 4096 -> 1024)
                    top_k: 10,             // 후보 단어를 줄여서 연산 속도 향상
                    temperature: 0,
                    // 모델이 답변을 멈춰야 할 토큰들을 명시적으로 추가
                    stop: [
                        "<|fim_prefix|>", 
                        "<|fim_suffix|>", 
                        "<|fim_middle|>", 
                        "<|file_separator|>", 
                        "```", 
                        "\n\n"
                    ] 
                }
            }),
            signal 
        });

        const data = await response.json() as { response: string };
      
        const rawResponse = data.response;
        let cleanResponse = rawResponse;
        
        // 1. 만약 응답에 마크다운 형식이 포함되었다면 코드만 추출 시도
        if (cleanResponse.includes("```")) {
            const lines = cleanResponse.split("\n");
            // 마크다운 시작 줄이 있다면 그 전까지만 사용
            cleanResponse = cleanResponse.split("```")[0];
        }
        console.log("여기 타나");
        // 2. 불필요하게 prefix나 suffix 내용이 중복되어 나오는지 체크 (모델이 FIM을 못 탔을 경우)
        // prefix의 끝부분이 결과에 포함되어 있다면 그 부분 이후만 반환
        const lastFewChars = prefix.trim().slice(-5);
        if (lastFewChars && cleanResponse.includes(lastFewChars)) {
            const splitParts = cleanResponse.split(lastFewChars);
            cleanResponse = splitParts[splitParts.length - 1];
        }

        return cleanResponse.trimEnd();
    } catch (error) {
        if ((error as Error).name === 'AbortError') {
            console.log("[FIM Debug] Request Aborted");
        } else {
            console.error("[FIM Debug] Error:", error);
        }
        return "";
    }
};


/**
 * OpenHands 에이전트에게 "행동"을 지시합니다. (예: 프로젝트 구조 생성, 라이브러리 설치 등)
 */
export const callOpenHandsAgent = async (task: string) => {
    try {
        const response = await axios.post(OPENHANDS_URL, {
            // 에이전트가 수행할 미션
            message: task,
            // 뇌가 될 모델 설정 (Gemma 4 추천)
            llm_config: {
                model: "gemma4", // 혹은 본인이 설치한 모델명
                provider: "ollama",
                base_url: "http://host.docker.internal:11434"
            }
        });

        // OpenHands는 세션 ID나 초기 상태를 반환합니다.
        console.log("OpenHands 에이전트 작업 시작:", response.data);
        return response.data;
    } catch (error) {
        console.error("OpenHands 에이전트 호출 실패:", error);
        return null;
    }
};