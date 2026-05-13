import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Arbiter Access Test Backend"
  });
});

app.post("/api/arbiter/test-login", async (req, res) => {

  const { username, password } = req.body;

  return res.json({
    status: "success",
    current_step: "backend_connected",
    login_success: false,
    received_username: !!username,
    received_password: !!password,
    message: "Railway backend is connected successfully."
  });

});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
