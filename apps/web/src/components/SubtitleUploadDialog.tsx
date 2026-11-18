import { X } from "lucide-react";
import React, { useCallback, useState } from "react";
import { ApiError, type SubtitleLang, type SubtitleUploadResponse } from "../lib/api";
import { formatBytes, formatLanguageLabel } from "../lib/format";

const ALLOWED_SUB_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt"];
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface SubtitleUploadDialogProps {
  isOpen: boolean;
  hasExistingTracks: boolean;
  onClose: () => void;
  onUpload: (params: {
    file: File;
    lang?: string;
    label?: string;
    isPrimary?: boolean;
  }) => Promise<SubtitleUploadResponse>;
  onConfirmUndLanguage: (trackId: number, lang: SubtitleLang) => Promise<void>;
}

export const SubtitleUploadDialog: React.FC<SubtitleUploadDialogProps> = ({
  isOpen,
  hasExistingTracks,
  onClose,
  onUpload,
  onConfirmUndLanguage,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [lang, setLang] = useState<string>("auto");
  const [label, setLabel] = useState<string>("");
  const [isPrimary, setIsPrimary] = useState<boolean>(!hasExistingTracks);
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [uploadResult, setUploadResult] = useState<SubtitleUploadResponse | null>(null);
  const [manualLangChoice, setManualLangChoice] = useState<SubtitleLang>("es");
  const [isSavingLang, setIsSavingLang] = useState(false);

  const resetForm = useCallback(() => {
    setSelectedFile(null);
    setLang("auto");
    setLabel("");
    setIsPrimary(!hasExistingTracks);
    setValidationError(null);
    setIsSubmitting(false);
    setUploadResult(null);
    setManualLangChoice("es");
    setIsSavingLang(false);
  }, [hasExistingTracks]);

  const handleClose = useCallback(() => {
    if (isSubmitting || isSavingLang) {
      return;
    }
    resetForm();
    onClose();
  }, [isSubmitting, isSavingLang, resetForm, onClose]);

  const validateAndPickFile = useCallback((file: File) => {
    setValidationError(null);
    const dotIndex = file.name.lastIndexOf(".");
    const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : "";
    if (!ALLOWED_SUB_EXTENSIONS.includes(ext)) {
      setValidationError(
        `Extensión no válida (${ext || "sin extensión"}). Formatos aceptados: ${ALLOWED_SUB_EXTENSIONS.join(", ")}`,
      );
      setSelectedFile(null);
      return;
    }
    if (file.size === 0) {
      setValidationError("El archivo de subtítulos está vacío.");
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_SUBTITLE_BYTES) {
      setValidationError(
        `El archivo supera el límite máximo de ${formatBytes(MAX_SUBTITLE_BYTES)}.`,
      );
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    const stem = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
    setLabel((prev) => (prev.trim() ? prev : stem));
  }, []);

  if (!isOpen) {
    return null;
  }

  const requiresLanguageSelection =
    uploadResult !== null && uploadResult.lang_detected && uploadResult.lang === "und";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setValidationError("Seleccioná un archivo de subtítulos.");
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);
    try {
      const response = await onUpload({
        file: selectedFile,
        lang,
        label: label.trim() || undefined,
        isPrimary: hasExistingTracks ? isPrimary : true,
      });
      setUploadResult(response);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : "Error al subir el subtítulo.";
      setValidationError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmUnd = async () => {
    if (!uploadResult) return;
    setIsSavingLang(true);
    setValidationError(null);
    try {
      await onConfirmUndLanguage(uploadResult.id, manualLangChoice);
      setUploadResult({
        ...uploadResult,
        lang: manualLangChoice,
        lang_detected: false,
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : "No se pudo actualizar el idioma.";
      setValidationError(msg);
    } finally {
      setIsSavingLang(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="subtitle-upload-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 id="subtitle-upload-title" className="text-base font-semibold text-ink">
            {uploadResult ? "Resumen de subtítulos importados" : "Añadir subtítulos"}
          </h2>
          {!requiresLanguageSelection && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="Cerrar diálogo"
              className="rounded-lg p-1 text-ink2 hover:bg-surface2 hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        {uploadResult ? (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-app/70 p-3.5 text-xs">
              <div>
                <span className="text-ink2">Etiqueta:</span>
                <p className="mt-0.5 font-semibold text-ink">{uploadResult.label}</p>
              </div>
              <div>
                <span className="text-ink2">Cantidad de cues:</span>
                <p className="mt-0.5 font-mono font-semibold text-accent">
                  {uploadResult.cue_count}
                </p>
              </div>
              <div>
                <span className="text-ink2">Idioma:</span>
                <p className="mt-0.5 font-semibold text-ink">
                  {formatLanguageLabel(uploadResult.lang)}{" "}
                  {uploadResult.lang_detected && (
                    <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-accent">
                      Auto-detectado
                    </span>
                  )}
                </p>
              </div>
              <div>
                <span className="text-ink2">Encoding / Formato:</span>
                <p className="mt-0.5 font-mono text-ink">
                  {uploadResult.detected_encoding ?? "utf-8"} · .
                  {uploadResult.source_format}
                </p>
              </div>
              <div>
                <span className="text-ink2">Cues descartados (skipped):</span>
                <p className="mt-0.5 font-mono text-ink">{uploadResult.skipped}</p>
              </div>
              <div>
                <span className="text-ink2">Rol de pista:</span>
                <p className="mt-0.5 font-semibold text-ink">
                  {uploadResult.is_primary ? "Primaria" : "Secundaria"}
                </p>
              </div>
            </div>

            {uploadResult.warnings.length > 0 && (
              <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs text-accent">
                <p className="font-semibold">Advertencias de normalización:</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {uploadResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {requiresLanguageSelection ? (
              <div className="rounded-lg border border-accent/50 bg-app p-4">
                <p className="text-xs font-semibold text-accent">
                  El idioma se detectó como «Sin definir (und)». Elegí el idioma de esta
                  pista para continuar:
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <select
                    aria-label="Seleccionar idioma de la pista"
                    value={manualLangChoice}
                    onChange={(e) => setManualLangChoice(e.target.value as SubtitleLang)}
                    className="flex-1 rounded-lg border border-lineStrong bg-surface px-3 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                  >
                    <option value="zh">中文 (Chino)</option>
                    <option value="es">Español</option>
                    <option value="en">English</option>
                    <option value="ja">日本語 (Japonés)</option>
                    <option value="ko">한국어 (Coreano)</option>
                  </select>
                  <button
                    type="button"
                    disabled={isSavingLang}
                    onClick={handleConfirmUnd}
                    className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-app hover:bg-accent/90 disabled:opacity-50"
                  >
                    {isSavingLang ? "Guardando..." : "Confirmar idioma"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-lg bg-accent px-5 py-2 text-xs font-semibold text-app hover:bg-accent/90"
                >
                  Listo
                </button>
              </div>
            )}

            {validationError && (
              <p role="alert" className="text-xs text-rose-400">
                {validationError}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {/* Zona Drag & Drop */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) {
                  validateAndPickFile(dropped);
                }
              }}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition ${
                isDragging
                  ? "border-accent bg-accent/10"
                  : "border-lineStrong bg-app/60 hover:border-lineStrong"
              }`}
            >
              <input
                id="subtitle-file-input"
                type="file"
                accept=".srt,.ass,.ssa,.vtt"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) {
                    validateAndPickFile(picked);
                  }
                }}
                className="sr-only"
              />
              <label
                htmlFor="subtitle-file-input"
                className="cursor-pointer text-xs text-ink"
              >
                {selectedFile ? (
                  <div>
                    <p className="font-semibold text-accent">{selectedFile.name}</p>
                    <p className="mt-1 text-[11px] text-ink2">
                      {formatBytes(selectedFile.size)} · Click para cambiar
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="font-medium text-ink">
                      Arrastrá un archivo de subtítulos o{" "}
                      <span className="text-accent underline">explorá tu disco</span>
                    </p>
                    <p className="mt-1 text-[11px] text-ink2">
                      Soporta .srt, .ass, .ssa, .vtt (UTF-8, GBK/GB18030, Big5, UTF-16 ·
                      máx. 5 MiB)
                    </p>
                  </div>
                )}
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="subtitle-lang-select"
                  className="block text-xs font-medium text-ink"
                >
                  Idioma
                </label>
                <select
                  id="subtitle-lang-select"
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                >
                  <option value="auto">Auto (detectar por Unicode)</option>
                  <option value="zh">中文 (Chino)</option>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                  <option value="ja">日本語 (Japonés)</option>
                  <option value="ko">한국어 (Coreano)</option>
                  <option value="und">Otro</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="subtitle-label-input"
                  className="block text-xs font-medium text-ink"
                >
                  Etiqueta (opcional)
                </label>
                <input
                  id="subtitle-label-input"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Ej. Chino simplificado"
                  className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={!hasExistingTracks || isPrimary}
                disabled={!hasExistingTracks}
                onChange={(e) => setIsPrimary(e.target.checked)}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
              />
              <span>
                Usar como pista primaria de estudio{" "}
                {!hasExistingTracks && "(la primera pista siempre es primaria)"}
              </span>
            </label>

            {validationError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-300"
              >
                {validationError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="rounded-lg bg-surface2 px-4 py-2 text-xs font-medium text-ink hover:bg-line"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!selectedFile || isSubmitting}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app hover:bg-accent/90 disabled:opacity-50"
              >
                {isSubmitting ? "Procesando..." : "Subir subtítulos"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
