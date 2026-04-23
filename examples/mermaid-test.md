---
title: Mermaid Rendering Test
author: Test Suite
date: 2026-04-23
tags: [mermaid, test, preview]
---

# Mermaid Rendering Test

Open this file in the browser via **Markdown: Open in Browser** (`Ctrl+Shift+Alt+V`) to verify mermaid rendering.

## 1. Flowchart with `<br/>` line breaks in labels

```mermaid
flowchart LR
    CAM[5x RTSP Cameras] --> INF[507-ai-inference<br/>RTSP + ONNX]
    SIM[509-sse-connector<br/>optional simulator] -.-> BROKER
    INF -->|events/.../heartbeat<br/>alerts/.../leak/basic<br/>alerts/.../leak/dlqc| BROKER[[AIO MQTT Broker]]
    BROKER -->|alerts/+/+/leak/basic<br/>alerts/+/+/leak/dlqc| MCS[503-media-capture-service]
    MCS --> ACSA[(ACSA Blob Storage)]
    BROKER -->|alerts/#| DF[AIO Dataflow]
    DF --> EH[[Event Hub<br/>2 partitions / 1d]]
    EH -->|notification CG| LA[Logic App] --> TEAMS[Microsoft Teams]
```

## 2. Sequence diagram

```mermaid
sequenceDiagram
    participant U as User
    participant E as Extension
    participant B as Browser
    U->>E: Run "Open in Browser"
    E->>E: Render markdown + mermaid
    E->>B: Open http://127.0.0.1:<port>
    B-->>U: Rendered page
```

## 3. Class diagram

```mermaid
classDiagram
    class PreviewServer {
        +publish(html, dir) Uri
        +dispose() void
    }
    class Extension {
        +activate(context) void
        +deactivate() void
    }
    Extension --> PreviewServer : uses
```

## 4. State diagram

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Rendering: command invoked
    Rendering --> Serving: html ready
    Serving --> Idle: browser opened
    Serving --> Error: publish failed
    Error --> Idle
```

## 5. Pie chart

```mermaid
pie title Preview content mix
    "Markdown" : 60
    "Mermaid"  : 25
    "Frontmatter" : 15
```

## 6. Gantt chart

```mermaid
gantt
    title Release 0.3.x
    dateFormat  YYYY-MM-DD
    section Features
    Frontmatter table    :done, 2026-04-20, 2d
    Mermaid support      :done, 2026-04-23, 1d
    section Fixes
    br/ in labels        :done, 2026-04-23, 1d
```

## 7. Non-mermaid fenced block (should remain a code block)

```ts
const answer: number = 42;
console.log(answer);
```
