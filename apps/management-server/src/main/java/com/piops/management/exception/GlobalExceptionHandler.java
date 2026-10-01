package com.piops.management.exception;

import com.piops.management.common.ApiResponse;
import jakarta.validation.ConstraintViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(RuntimeClientException.class)
    public ResponseEntity<ApiResponse<Void>> handleRuntimeClient(RuntimeClientException error) {
        return ResponseEntity
                .status(error.getStatus())
                .body(ApiResponse.failure(error.getCode(), error.getMessage()));
    }

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotFound(ResourceNotFoundException error) {
        return ResponseEntity
                .status(HttpStatus.NOT_FOUND)
                .body(ApiResponse.failure("NOT_FOUND", error.getMessage()));
    }

    @ExceptionHandler(ConflictException.class)
    public ResponseEntity<ApiResponse<Void>> handleConflict(ConflictException error) {
        return ResponseEntity
                .status(HttpStatus.CONFLICT)
                .body(ApiResponse.failure("CONFLICT", error.getMessage()));
    }

    @ExceptionHandler({
            ConstraintViolationException.class,
            MethodArgumentNotValidException.class,
            MissingRequestHeaderException.class,
            HttpMessageNotReadableException.class,
            InvalidRequestException.class
    })
    public ResponseEntity<ApiResponse<Void>> handleBadRequest(Exception error) {
        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST)
                .body(ApiResponse.failure("INVALID_REQUEST", validationMessage(error)));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnexpected(Exception error) {
        return ResponseEntity
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.failure("INTERNAL_ERROR", "Unexpected management server error"));
    }

    private String validationMessage(Exception error) {
        if (error instanceof MethodArgumentNotValidException validation
                && validation.getBindingResult().getFieldError() != null) {
            var fieldError = validation.getBindingResult().getFieldError();
            return fieldError.getField() + ": " + fieldError.getDefaultMessage();
        }
        if (error instanceof HttpMessageNotReadableException) {
            return "Request body is missing or malformed";
        }
        return error.getMessage() == null ? "Invalid request" : error.getMessage();
    }
}
