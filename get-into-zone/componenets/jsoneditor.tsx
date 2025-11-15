"use client"

import { Editor } from "@monaco-editor/react";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface JsonEditorProps {
    value: any;
    onChange: (value: any) => void;
    height?: string;
    className?: string;
}

export const JsonEditor: React.FC<JsonEditorProps> = ({
    value,
    onChange,
    height = "400px",
    className = "",
}) => {
    const { theme } = { theme: "light" }
    const [jsonString, setJsonString] = useState("");
    const [isValid, setIsValid] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Initialize JSON string from value
    useEffect(() => {
        try {
            const formatted = JSON.stringify(value, null, 2);
            setJsonString(formatted);
            setIsValid(true);
            setError(null);
        } catch (err) {
            setError("Invalid JSON format");
            setIsValid(false);
        }
    }, [value]);

    const handleEditorChange = useCallback((newValue: string | undefined) => {
        if (newValue === undefined) return;

        setJsonString(newValue);

        try {
            const parsed = JSON.parse(newValue);
            setIsValid(true);
            setError(null);
            onChange(parsed);
        } catch (err) {
            setIsValid(false);
            setError(err instanceof Error ? err.message : "Invalid JSON");
        }
    }, [onChange]);

    const editorTheme = theme === "dark" ? "vs-dark" : "light";

    return (
        <div className={`relative ${className}`}>
            <Editor
                height={height}
                defaultLanguage="json"
                value={jsonString}
                onChange={handleEditorChange}
                theme={editorTheme}
                options={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 14,
                    lineNumbers: "on",
                    roundedSelection: false,
                    scrollbar: {
                        vertical: "auto",
                        horizontal: "auto",
                    },
                    automaticLayout: true,
                    tabSize: 2,
                    insertSpaces: true,
                    wordWrap: "on",
                    formatOnPaste: true,
                    formatOnType: true,
                    bracketPairColorization: {
                        enabled: true,
                    },
                    suggest: {
                        showKeywords: true,
                        showSnippets: true,
                    },
                }}
                className="border rounded-md"
            />

            {!isValid && error && (
                <div className="flex items-center gap-2 mt-2 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" />
                    {error}
                </div>
            )}

            {isValid && (
                <div className="flex items-center gap-2 mt-2 text-sm text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    Valid JSON
                </div>
            )}
        </div>
    );
};
