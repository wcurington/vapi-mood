// flow_runner_v1.0.0.js
// Flow execution engine for Alex's sales flow

'use strict';

const fs = require('fs');
const path = require('path');

class FlowRunner {
  constructor(flowPath) {
    this.flowPath = flowPath || path.join(__dirname, 'flows_alex_sales.json');
    this.flow = null;
    this.currentStage = null;
  }

  loadFlow() {
    if (!fs.existsSync(this.flowPath)) {
      throw new Error(`Flow file not found: ${this.flowPath}`);
    }
    this.flow = JSON.parse(fs.readFileSync(this.flowPath, 'utf8'));
    console.log('[flow_runner] loaded flow v' + this.flow.version);
    this.currentStage = this.flow.stages[0];
  }

  nextStage() {
    if (!this.currentStage) throw new Error('No current stage');
    if (this.currentStage.next === 'end') {
      console.log('[flow_runner] flow complete');
      return null;
    }
    const nextId = this.currentStage.next;
    const stage = this.flow.stages.find(s => s.id === nextId);
    if (!stage) throw new Error('Stage not found: ' + nextId);
    this.currentStage = stage;
    return stage;
  }

  getPrompt() {
    if (!this.currentStage) return null;
    return this.currentStage.prompt;
  }
}

if (require.main === module) {
  const runner = new FlowRunner();
  runner.loadFlow();
  console.log('First prompt:', runner.getPrompt());
  let stage;
  while ((stage = runner.nextStage())) {
    console.log('Next prompt:', stage.prompt);
  }
}

module.exports = FlowRunner;
