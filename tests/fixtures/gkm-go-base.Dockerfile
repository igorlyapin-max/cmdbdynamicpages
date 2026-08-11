ARG BASE_IMAGE=golang:1.25.11-alpine@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2
FROM ${BASE_IMAGE}

RUN apk add --no-cache ca-certificates && update-ca-certificates
