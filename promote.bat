@echo off
REM Auto-promote latest server/build_flow, rebuild flows, git commit+push, pm2 restart, and auto-bump versions with skeleton stubs

set ROOT=%~dp0

REM Find latest versions
for /f "delims=" %%f in ('dir /b /od "%ROOT%server_v*.js"') do set LATEST_SERVER=%%f
for /f "delims=" %%f in ('dir /b /od "%ROOT%build_flow_v*.js"') do set LATEST_FLOW=%%f

echo Promoting %LATEST_SERVER% -> server.js
copy /Y "%ROOT%%LATEST_SERVER%" "%ROOT%server.js"

echo Promoting %LATEST_FLOW% -> build_flow.js
copy /Y "%ROOT%%LATEST_FLOW%" "%ROOT%build_flow.js"

echo Running build_flow.js to regenerate flows
node "%ROOT%build_flow.js"

echo Committing and pushing to git...
cd "%ROOT%"
git add server.js build_flow.js flows/flows_alex_sales.json %LATEST_SERVER% %LATEST_FLOW%
git commit -m "Promote %LATEST_SERVER% + %LATEST_FLOW%"
git push

echo Restarting pm2 process: vapi-render
pm2 restart vapi-render

REM -------- Auto-bump version numbers --------
for /f "tokens=2,3 delims=v." %%a in ("%LATEST_SERVER%") do set MAJ=%%a& set MIN=%%b
for /f "tokens=3 delims=." %%c in ("%LATEST_SERVER%") do set PATCH=%%c
set /a PATCH=PATCH+1
set NEXT_SERVER=server_v%MAJ%.%MIN%.%PATCH%.js

for /f "tokens=2,3 delims=v." %%a in ("%LATEST_FLOW%") do set FMAJ=%%a& set FMIN=%%b
for /f "tokens=3 delims=." %%c in ("%LATEST_FLOW%") do set FPATCH=%%c
set /a FPATCH=FPATCH+1
set NEXT_FLOW=build_flow_v%FMAJ%.%FMIN%.%FPATCH%.js

echo Creating new skeleton stubs: %NEXT_SERVER% and %NEXT_FLOW%

(
echo /** 
echo  * %NEXT_SERVER% - auto-generated skeleton
echo  */
echo 'use strict^';
echo const express = require('express'^);
echo const app = express(^);
echo app.get('/health', (req,res) => res.json({status:'UP', version:'%NEXT_SERVER%'}));
echo module.exports = app;
) > "%ROOT%%NEXT_SERVER%"

(
echo // %NEXT_FLOW% - auto-generated skeleton
echo 'use strict^';
echo module.exports = { buildFlow: () => ({version:"stub", stages:[]}) };
) > "%ROOT%%NEXT_FLOW%"

echo Promotion complete. Next versions are ready for editing: %NEXT_SERVER% and %NEXT_FLOW%
pause
