"""추론 디바이스 감지 probe (6.0-12). onnxruntime EP 목록과 CUDA 가용 여부만 JSON으로 출력하고 종료한다.

Node 서버(admin 라우트)가 직접 onnxruntime를 호출할 수 없으므로(추론은 Python venv/컨테이너에서 실행),
같은 Python 환경에서 이 스크립트를 돌려 GPU 사용 가능 여부를 신뢰성 있게 감지한다. 모델 로드·영상 입력 불필요.

출력 예: {"cudaAvailable": false, "providers": ["CPUExecutionProvider"]}
onnxruntime-gpu 미설치 환경에서는 cudaAvailable=false(관리자 UI가 "CUDA provider 미설치/감지 불가" 표시).
"""
import json

from model_loader import available_providers


def main():
    providers = available_providers()
    print(json.dumps({
        "cudaAvailable": "CUDAExecutionProvider" in providers,
        "providers": providers,
    }))


if __name__ == "__main__":
    main()
