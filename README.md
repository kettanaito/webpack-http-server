# webpack-http-server

On-demand runtime webpack compilations over HTTP.

## Overview

This package is, effectively, an Express server that exposes webpack compilations over HTTP. This means you can request to compile a module on runtime by dispatching a request like this:

```
POST http://127.0.0.1:8080/compilation
Content-Type: application/json

{"entry":"/Users/you/some/module.js"}
```

The server will respond you with the compilation info:

```ts
{
  "id": "COMPILATION_ID",
  "previewUrl": "http://127.0.0.1/compilation/"
}
```

Each compilation request creates a unique compilation ID and `/compilations/:id` route to preview the runtime of the given module after it's compiled.

## Motivation

I've build this library because I'm a fan of example-driven testing. When I employ it on bigger projects, it means that every test I have has a runtime usage example alongside it. While I could compile those examples before tests, I chose to have a runtime compilation server instead. Here are my reasons:

1. Compilation server guarantees up-to-date examples. I may forget to run `npm run build:examples` before running tests, which will yield irrelevant test results.
1. Compilation server is more performant. By using the server and compiling only those examples that my current test run needs, I can save resources by skipping irrelevant examples.
1. Compilation server creates a runtime. Even if I build examples before tests, I still need something to serve them. This server does that as well via compilation previews.

### Why not `webpack-dev-server`?

Webpack Dev Server is a great tool to run your compilation over HTTP. However, it's scoped to _a single compilation_. You cannot change the entrypoint for your dev server without having to stop it, modify the webpack config, and re-run the server. This is extremely time consuming and unreliable.

## Getting started

### Install

```sh
npm install webpack-http-server
```

### Create a server

```js
import { WebpackHttpServer } from 'webpack-http-server'

const server = new WebpackHttpServer()
await server.listen()

console.log('Compilation server listening at "%s"', server.serverUrl)
```

> The compilation server runs on a random vacant port. Rely on the `serverUrl` property to get its full address.

### Request a compilation

There are two ways to request a compilation: HTTP request and Node.js API.

#### HTTP request

```js
fetch(`${server.serverUrl}/compilation`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    entry: '/Users/octocat/projects/demo/index.js',
  }),
})
```

#### Node.js API

```js
const result = await server.compile(['/Users/octocat/projects/demo/index.js'])
console.log('preview is running on "%s"', result.previewUrl)
```
