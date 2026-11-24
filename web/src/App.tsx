import { useTranslation } from "react-i18next";
import { Route, Routes } from "react-router";

import { RequireClinician } from "./components/ClinicianShell.tsx";
import { ClinicianList } from "./pages/ClinicianList.tsx";
import { ClinicianLogin } from "./pages/ClinicianLogin.tsx";
import { ClinicianVisit } from "./pages/ClinicianVisit.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { PatientPage } from "./pages/PatientPage.tsx";
import { SafetyPage } from "./pages/SafetyPage.tsx";

export function App() {
  const { t } = useTranslation();
  return (
    <>
      <a className="skip-link" href="#main">
        {t("app.skip")}
      </a>
      <Routes>
        <Route path="/" element={<PatientPage />} />
        <Route path="/safety" element={<SafetyPage />} />
        <Route path="/clinician/login" element={<ClinicianLogin />} />
        <Route
          path="/clinician"
          element={
            <RequireClinician>
              <ClinicianList />
            </RequireClinician>
          }
        />
        <Route
          path="/clinician/visits/:id"
          element={
            <RequireClinician>
              <ClinicianVisit />
            </RequireClinician>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
