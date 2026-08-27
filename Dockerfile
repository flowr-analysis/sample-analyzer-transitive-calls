# syntax=docker/dockerfile:1

FROM node:26.7-alpine3.24 AS builder

WORKDIR /app

# copy the source and build files of all modules into the workdir
COPY ./src /app/src
COPY ./package.json ./package-lock.json ./tsconfig.json /app/

# install python and build tools for node-gyp
RUN apk add --no-cache python3 make g++

# install and build all modules
RUN npm ci && npm run build

# fetch flowR's signature database into the image, so a container run needs no network to resolve
# a call into a package to its `pkg::fn` name (see src/sigdb.ts); a failed fetch is not fatal
ENV FLOWR_CACHE_DIR=/app/cache
RUN npm run sigdb

FROM node:26.7-alpine3.24 AS analyzer-sample

LABEL author="Florian Sihler" git="https://github.com/flowr-analysis/sample-analyzer-transitive-calls"

WORKDIR /app

# copy all package.jsons so we can install them (see below)
COPY ./package.json ./package-lock.json /app/
COPY --from=builder /app/dist /app
COPY --from=builder /app/cache /app/cache

# the prefetched signature database, writable so flowR may cache its decompressed shards next to it
ENV FLOWR_CACHE_DIR=/app/cache

# make new user and clean up the test files
RUN rm -rf /app/**/tsconfig.tsbuildinfo /app/**/*.d.ts /app/test/* && addgroup -S flowr && adduser -S flowr -G flowr && chown -R flowr:flowr /app/cache
USER flowr

# we also configure basic memory options
ENTRYPOINT [\
   "node",\
   "--max-old-space-size=8192",\
   "--stack-size=8192",\
   "--max-semi-space-size=8192",\
   "/app/main.min.js"\
  ]
