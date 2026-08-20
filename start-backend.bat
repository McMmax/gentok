@echo off
cd /d "%~dp0backend"
echo Installing backend dependencies (same Python that will run uvicorn)...
echo.
echo Installing PyTorch (CPU build) first -- this powers the new voice-isolation/
echo music-ducking feature. Installing plain "pip install demucs" without this step
echo first pulls a full NVIDIA CUDA toolkit as a side dependency (several GB) even on
echo machines with no GPU, so we grab the much smaller CPU-only build explicitly.
echo This only downloads anything the very first time -- instant if already installed.
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
echo.
python -m pip install -r requirements.txt
echo.
echo Starting GenTok backend on http://127.0.0.1:8000 ...
echo Leave this window open while you use the app. Press CTRL+C to stop it.
echo.
python -m uvicorn app.main:app --reload --port 8000
pause
